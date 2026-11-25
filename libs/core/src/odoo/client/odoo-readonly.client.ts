import { Injectable } from '@nestjs/common';
import { ODOO_READ_ONLY_METHODS, ODOO_RPC_TIMEOUT_MS, OdooStockField } from '../odoo.constants.js';
import type {
  OdooAdvancedSettings,
  OdooCategoryOption,
  OdooCredentialsInput,
  OdooDiscoveredCapabilities,
  OdooPricelistOption,
  OdooSyncFilterInput,
  OdooWarehouseOption,
} from '../entities/odoo-connection.js';
import { formatOdooDecimal } from '../rules/odoo-document-classifier.js';

type Many2OneValue = [number, string] | false | null | undefined;
type OdooDomainTerm = [string, string, unknown] | '|' | '&';

interface JsonRpcResponse<Result> {
  result?: Result;
  error?: {
    message?: string;
    data?: { message?: string; name?: string };
  };
}

interface OdooFieldMeta {
  type?: string;
  string?: string;
  relation?: string;
}

export interface OdooAttachmentRecord {
  id: number;
  documentId: number | null;
  name: string;
  mimetype: string;
  fileSize: number | null;
  isPublic: boolean;
  datasBase64: string | null;
}

export interface OdooVariantSnapshot {
  id: number;
  sku: string | null;
  barcode: string | null;
  price: number;
  cost: number | null;
  weightKg: number | null;
  volume: number | null;
  qtyAvailable: number;
  freeQty: number;
  optionValues: string[];
  imageBase64: string | null;
}

export interface OdooTemplateSnapshot {
  id: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  descriptionHtml: string;
  listPrice: number;
  cost: number | null;
  weightKg: number | null;
  volume: number | null;
  taxNames: string[];
  taxable: boolean;
  optionNames: string[];
  mainImageBase64: string | null;
  variants: OdooVariantSnapshot[];
  attachments: OdooAttachmentRecord[];
  customFieldValues: Record<string, unknown>;
}

export interface OdooRawPreviewRow {
  templateId: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  listPrice: string;
  qtyAvailable: number;
  variantCount: number;
  documentCount: number;
  hasMainImage: boolean;
}

interface OdooSession {
  url: string;
  database: string;
  uid: number;
  apiKey: string;
}

const BRAND_FIELD_CANDIDATES = ['brand_id', 'product_brand_id', 'x_brand', 'x_studio_brand'];
const EXTRA_IMAGE_MODELS = ['product.image'];
const MAX_PRODUCT_OPTIONS = 3;

function normalizeOdooUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Odoo URL must use http or https');
  }
  return trimmed;
}

function many2OneName(value: Many2OneValue): string | null {
  if (Array.isArray(value) && typeof value[1] === 'string' && value[1].trim().length > 0) {
    return value[1].trim();
  }
  return null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Strictly read-only JSON-RPC client for Odoo 18.
 * Enforces an explicit method allowlist (`fields_get`, `search`, `search_read`, `search_count`, `read`)
 * so write RPC calls (`create`, `write`, `unlink`, action methods) can never be issued.
 */
@Injectable()
export class OdooReadOnlyClient {
  async authenticate(credentials: OdooCredentialsInput): Promise<OdooSession> {
    const url = normalizeOdooUrl(credentials.url);
    const database = credentials.database.trim();
    const username = credentials.username.trim();
    const apiKey = credentials.apiKey.trim();

    if (!database || !username || !apiKey) {
      throw new Error('URL, database, username, and API key are required');
    }

    const uid = await this.jsonRpc<number | false>(url, 'common', 'authenticate', [
      database,
      username,
      apiKey,
      {},
    ]);
    if (typeof uid !== 'number' || uid <= 0) {
      throw new Error('Odoo rejected the database, username, or API key');
    }
    return { url, database, uid, apiKey };
  }

  async discoverInstance(credentials: OdooCredentialsInput): Promise<OdooDiscoveredCapabilities> {
    const session = await this.authenticate(credentials);
    const versionInfo = await this.jsonRpc<{ server_version?: string }>(
      session.url,
      'common',
      'version',
      [],
    );

    const [companies, warehouses, pricelists, categories, tmplFields, productCount] =
      await Promise.all([
        this.readModel<Record<string, unknown>>(session, 'res.company', 'search_read', [[]], {
          fields: ['id', 'name', 'currency_id'],
          limit: 5,
        }),
        this.safeReadModel<Record<string, unknown>>(
          session,
          'stock.warehouse',
          'search_read',
          [[]],
          {
            fields: ['id', 'name', 'code'],
            limit: 50,
          },
        ),
        this.safeReadModel<Record<string, unknown>>(
          session,
          'product.pricelist',
          'search_read',
          [[['active', '=', true]]],
          { fields: ['id', 'name', 'currency_id'], limit: 50 },
        ),
        this.safeReadModel<Record<string, unknown>>(
          session,
          'product.category',
          'search_read',
          [[]],
          { fields: ['id', 'complete_name', 'name'], limit: 100 },
        ),
        this.executeRead<Record<string, OdooFieldMeta>>(
          session,
          'product.template',
          'fields_get',
          [],
          { attributes: ['type', 'string', 'relation'] },
        ),
        this.executeRead<number>(session, 'product.template', 'search_count', [
          [['active', '=', true]],
        ]),
      ]);

    const company = companies[0];
    const companyName = optionalText(company?.name);
    const currency = many2OneName(company?.currency_id as Many2OneValue) ?? 'USD';

    const brandField = BRAND_FIELD_CANDIDATES.find((candidate) => candidate in tmplFields) ?? null;
    const hasProductDocuments =
      'product_document_ids' in tmplFields && (await this.modelExists(session, 'product.document'));
    const hasProductImages = await this.modelExists(session, EXTRA_IMAGE_MODELS[0]);

    const mappedWarehouses: OdooWarehouseOption[] = warehouses.map((wh) => ({
      id: Number(wh.id),
      name: optionalText(wh.name) ?? `Warehouse ${String(wh.id)}`,
      code: optionalText(wh.code) ?? '',
    }));
    const mappedPricelists: OdooPricelistOption[] = pricelists.map((pl) => ({
      id: Number(pl.id),
      name: optionalText(pl.name) ?? `Pricelist ${String(pl.id)}`,
      currency: many2OneName(pl.currency_id as Many2OneValue),
    }));
    const mappedCategories: OdooCategoryOption[] = categories.map((cat) => ({
      id: Number(cat.id),
      name:
        optionalText(cat.complete_name) ?? optionalText(cat.name) ?? `Category ${String(cat.id)}`,
    }));

    return {
      serverVersion: versionInfo?.server_version ?? '18.0',
      companyName,
      currency,
      productCount,
      warehouses: mappedWarehouses,
      pricelists: mappedPricelists,
      categories: mappedCategories,
      brandField,
      hasProductDocuments,
      hasProductImages,
    };
  }

  async previewProducts(
    credentials: OdooCredentialsInput,
    options: { search?: string; limit: number; settings?: OdooAdvancedSettings },
  ): Promise<OdooRawPreviewRow[]> {
    const session = await this.authenticate(credentials);
    const tmplFields = await this.executeRead<Record<string, OdooFieldMeta>>(
      session,
      'product.template',
      'fields_get',
      [],
      { attributes: ['type'] },
    );
    const brandField = this.resolveBrandField(tmplFields, options.settings?.brandField);
    const hasDocCount = 'product_document_count' in tmplFields;

    const domain: OdooDomainTerm[] = [['active', '=', true]];
    if (options.settings?.filterSaleOnly) {
      domain.push(['sale_ok', '=', true]);
    }
    if (options.settings?.filterCategoryIds && options.settings.filterCategoryIds.length > 0) {
      domain.push(['categ_id', 'in', options.settings.filterCategoryIds]);
    }

    const search = options.search?.trim();
    if (search) {
      domain.push(
        '|',
        '|',
        ['name', 'ilike', search],
        ['default_code', 'ilike', search],
        ['barcode', 'ilike', search],
      );
    }

    const fields = [
      'id',
      'name',
      'default_code',
      'barcode',
      'list_price',
      'qty_available',
      'categ_id',
      'product_variant_count',
      'image_128',
      ...(brandField ? [brandField] : []),
      ...(hasDocCount ? ['product_document_count'] : []),
    ];

    const context = options.settings?.warehouseId
      ? { warehouse: options.settings.warehouseId }
      : undefined;

    const rows = await this.readModel<Record<string, unknown>>(
      session,
      'product.template',
      'search_read',
      [domain],
      {
        fields,
        limit: options.limit,
        order: 'id asc',
        ...(context ? { context } : {}),
      },
    );

    return rows.map((row) => ({
      templateId: Number(row.id),
      name: optionalText(row.name) ?? `Producto ${String(row.id)}`,
      sku: optionalText(row.default_code),
      barcode: optionalText(row.barcode),
      brand: brandField ? this.extractBrandValue(row[brandField]) : null,
      category: many2OneName(row.categ_id as Many2OneValue),
      listPrice: formatOdooDecimal(optionalNumber(row.list_price)),
      qtyAvailable: Math.max(0, Math.floor(optionalNumber(row.qty_available) ?? 0)),
      variantCount: Math.max(1, Math.floor(optionalNumber(row.product_variant_count) ?? 1)),
      documentCount: hasDocCount ? Math.floor(optionalNumber(row.product_document_count) ?? 0) : 0,
      hasMainImage: Boolean(row.image_128),
    }));
  }

  async resolveTemplateIds(
    credentials: OdooCredentialsInput,
    filter: OdooSyncFilterInput | undefined,
    settings: OdooAdvancedSettings,
  ): Promise<number[]> {
    const session = await this.authenticate(credentials);
    const domain: OdooDomainTerm[] = [['active', '=', true]];

    const saleOnly = filter?.saleOnly ?? settings.filterSaleOnly;
    if (saleOnly) domain.push(['sale_ok', '=', true]);

    const categoryIds = filter?.categoryIds?.length
      ? filter.categoryIds
      : settings.filterCategoryIds;
    if (categoryIds && categoryIds.length > 0) {
      domain.push(['categ_id', 'in', categoryIds]);
    }

    const selectors: OdooDomainTerm[] = [];
    if (filter?.templateIds && filter.templateIds.length > 0) {
      selectors.push(['id', 'in', filter.templateIds]);
    }
    if (filter?.skus && filter.skus.length > 0) {
      selectors.push(['default_code', 'in', filter.skus]);
    }
    if (filter?.barcodes && filter.barcodes.length > 0) {
      selectors.push(['barcode', 'in', filter.barcodes]);
    }
    if (selectors.length === 1) {
      domain.push(selectors[0]);
    } else if (selectors.length > 1) {
      for (let idx = 0; idx < selectors.length - 1; idx += 1) {
        domain.push('|');
      }
      domain.push(...selectors);
    }

    const ids = await this.executeRead<number[]>(session, 'product.template', 'search', [domain], {
      ...(filter?.limit ? { limit: filter.limit } : {}),
      order: 'id asc',
    });
    return ids;
  }

  async fetchTemplateBatch(
    credentials: OdooCredentialsInput,
    templateIds: number[],
    settings: OdooAdvancedSettings,
  ): Promise<OdooTemplateSnapshot[]> {
    if (templateIds.length === 0) return [];
    const session = await this.authenticate(credentials);
    const tmplFields = await this.executeRead<Record<string, OdooFieldMeta>>(
      session,
      'product.template',
      'fields_get',
      [],
      { attributes: ['type'] },
    );
    const brandField = this.resolveBrandField(tmplFields, settings.brandField);
    const customFields = (settings.customFields ?? []).filter((field) => field in tmplFields);
    const hasPublicDesc = 'public_description' in tmplFields;
    const hasDocuments = 'product_document_ids' in tmplFields;
    const hasImageField = 'image_1920' in tmplFields;

    const fields = [
      'id',
      'name',
      'default_code',
      'barcode',
      'list_price',
      'standard_price',
      'weight',
      'volume',
      'categ_id',
      'taxes_id',
      'description_sale',
      'description',
      'product_variant_ids',
      'attribute_line_ids',
      ...(hasPublicDesc ? ['public_description'] : []),
      ...(hasImageField ? ['image_1920'] : []),
      ...(hasDocuments ? ['product_document_ids'] : []),
      ...(brandField ? [brandField] : []),
      ...customFields,
    ];

    const context: Record<string, unknown> = {};
    if (settings.warehouseId) context.warehouse = settings.warehouseId;
    if (settings.pricelistId) context.pricelist = settings.pricelistId;

    const templates = await this.readModel<Record<string, unknown>>(
      session,
      'product.template',
      'read',
      [templateIds],
      { fields, ...(Object.keys(context).length > 0 ? { context } : {}) },
    );

    const allVariantIds = templates.flatMap((tmpl) =>
      Array.isArray(tmpl.product_variant_ids) ? (tmpl.product_variant_ids as number[]) : [],
    );
    const allTaxIds = [
      ...new Set(
        templates.flatMap((tmpl) =>
          Array.isArray(tmpl.taxes_id) ? (tmpl.taxes_id as number[]) : [],
        ),
      ),
    ];
    const allAttrLineIds = [
      ...new Set(
        templates.flatMap((tmpl) =>
          Array.isArray(tmpl.attribute_line_ids) ? (tmpl.attribute_line_ids as number[]) : [],
        ),
      ),
    ];

    const [variantsRaw, taxesRaw, attrLinesRaw] = await Promise.all([
      allVariantIds.length > 0
        ? this.readModel<Record<string, unknown>>(
            session,
            'product.product',
            'read',
            [allVariantIds],
            {
              fields: [
                'id',
                'product_tmpl_id',
                'default_code',
                'barcode',
                'lst_price',
                'standard_price',
                'weight',
                'volume',
                'qty_available',
                'free_qty',
                'product_template_attribute_value_ids',
                'image_variant_1920',
              ],
              ...(Object.keys(context).length > 0 ? { context } : {}),
            },
          )
        : Promise.resolve([]),
      allTaxIds.length > 0
        ? this.safeReadModel<Record<string, unknown>>(session, 'account.tax', 'read', [allTaxIds], {
            fields: ['id', 'name'],
          })
        : Promise.resolve([]),
      allAttrLineIds.length > 0
        ? this.safeReadModel<Record<string, unknown>>(
            session,
            'product.template.attribute.line',
            'read',
            [allAttrLineIds],
            { fields: ['id', 'product_tmpl_id', 'attribute_id'] },
          )
        : Promise.resolve([]),
    ]);

    const ptavIds = [
      ...new Set(
        variantsRaw.flatMap((variant) =>
          Array.isArray(variant.product_template_attribute_value_ids)
            ? (variant.product_template_attribute_value_ids as number[])
            : [],
        ),
      ),
    ];
    const ptavRaw =
      ptavIds.length > 0
        ? await this.safeReadModel<Record<string, unknown>>(
            session,
            'product.template.attribute.value',
            'read',
            [ptavIds],
            { fields: ['id', 'attribute_id', 'name'] },
          )
        : [];

    const attachmentsByTemplate = await this.fetchAttachmentsForTemplates(
      session,
      templateIds,
      allVariantIds,
      hasDocuments,
    );

    const taxNameById = new Map<number, string>(
      taxesRaw.map((tax) => [Number(tax.id), optionalText(tax.name) ?? String(tax.id)]),
    );
    const ptavById = new Map<number, { attributeId: number; value: string }>(
      ptavRaw.map((row) => [
        Number(row.id),
        {
          attributeId: Array.isArray(row.attribute_id) ? Number(row.attribute_id[0]) : 0,
          value: optionalText(row.name) ?? '',
        },
      ]),
    );
    const attrLinesByTemplate = new Map<number, { attributeId: number; name: string }[]>();
    for (const line of attrLinesRaw) {
      const tmplId = Array.isArray(line.product_tmpl_id) ? Number(line.product_tmpl_id[0]) : 0;
      const attrId = Array.isArray(line.attribute_id) ? Number(line.attribute_id[0]) : 0;
      const attrName = many2OneName(line.attribute_id as Many2OneValue);
      if (!tmplId || !attrId || !attrName) continue;
      const list = attrLinesByTemplate.get(tmplId) ?? [];
      list.push({ attributeId: attrId, name: attrName });
      attrLinesByTemplate.set(tmplId, list);
    }

    const variantsByTemplate = new Map<number, Record<string, unknown>[]>();
    for (const variant of variantsRaw) {
      const tmplId = Array.isArray(variant.product_tmpl_id)
        ? Number(variant.product_tmpl_id[0])
        : 0;
      const list = variantsByTemplate.get(tmplId) ?? [];
      list.push(variant);
      variantsByTemplate.set(tmplId, list);
    }

    return templates.map((tmpl) => {
      const templateId = Number(tmpl.id);
      const attrDefs = (attrLinesByTemplate.get(templateId) ?? []).slice(0, MAX_PRODUCT_OPTIONS);
      const optionNames = attrDefs.map((def) => def.name);
      const rawVariants = variantsByTemplate.get(templateId) ?? [];

      const variants: OdooVariantSnapshot[] = rawVariants.map((variant) => {
        const variantPtavIds = Array.isArray(variant.product_template_attribute_value_ids)
          ? (variant.product_template_attribute_value_ids as number[])
          : [];
        const valueByAttr = new Map<number, string>();
        for (const ptavId of variantPtavIds) {
          const entry = ptavById.get(ptavId);
          if (entry && entry.value) valueByAttr.set(entry.attributeId, entry.value);
        }
        const optionValues = attrDefs.map((def) => valueByAttr.get(def.attributeId) ?? 'Default');
        const qtyAvailable = Math.max(0, Math.floor(optionalNumber(variant.qty_available) ?? 0));
        const freeQty = Math.max(0, Math.floor(optionalNumber(variant.free_qty) ?? qtyAvailable));
        return {
          id: Number(variant.id),
          sku: optionalText(variant.default_code),
          barcode: optionalText(variant.barcode),
          price: optionalNumber(variant.lst_price) ?? optionalNumber(tmpl.list_price) ?? 0,
          cost: optionalNumber(variant.standard_price) ?? optionalNumber(tmpl.standard_price),
          weightKg: optionalNumber(variant.weight) ?? optionalNumber(tmpl.weight),
          volume: optionalNumber(variant.volume) ?? optionalNumber(tmpl.volume),
          qtyAvailable,
          freeQty,
          optionValues,
          imageBase64: optionalText(variant.image_variant_1920),
        };
      });

      const taxIds = Array.isArray(tmpl.taxes_id) ? (tmpl.taxes_id as number[]) : [];
      const taxNames = taxIds.map((id) => taxNameById.get(id) ?? String(id));
      const descriptionHtml =
        optionalText(tmpl.public_description) ??
        optionalText(tmpl.description_sale) ??
        optionalText(tmpl.description) ??
        '';

      const customFieldValues: Record<string, unknown> = {};
      for (const field of customFields) {
        if (tmpl[field] !== false && tmpl[field] !== null && tmpl[field] !== undefined) {
          customFieldValues[field] = tmpl[field];
        }
      }

      return {
        id: templateId,
        name: optionalText(tmpl.name) ?? `Producto ${templateId}`,
        sku: optionalText(tmpl.default_code),
        barcode: optionalText(tmpl.barcode),
        brand: brandField ? this.extractBrandValue(tmpl[brandField]) : null,
        category: many2OneName(tmpl.categ_id as Many2OneValue),
        descriptionHtml,
        listPrice: optionalNumber(tmpl.list_price) ?? 0,
        cost: optionalNumber(tmpl.standard_price),
        weightKg: optionalNumber(tmpl.weight),
        volume: optionalNumber(tmpl.volume),
        taxNames,
        taxable: taxIds.length > 0,
        optionNames,
        mainImageBase64: optionalText(tmpl.image_1920),
        variants,
        attachments: attachmentsByTemplate.get(templateId) ?? [],
        customFieldValues,
      };
    });
  }

  async readAttachmentContent(
    credentials: OdooCredentialsInput,
    attachmentId: number,
  ): Promise<{ name: string; mimetype: string; content: Buffer } | null> {
    const session = await this.authenticate(credentials);
    const rows = await this.readModel<Record<string, unknown>>(
      session,
      'ir.attachment',
      'read',
      [[attachmentId]],
      { fields: ['id', 'name', 'mimetype', 'datas'] },
    );
    const row = rows[0];
    const datas = optionalText(row?.datas);
    if (!row || !datas) return null;
    return {
      name: optionalText(row.name) ?? `document-${attachmentId}`,
      mimetype: optionalText(row.mimetype) ?? 'application/octet-stream',
      content: Buffer.from(datas, 'base64'),
    };
  }

  selectStockQuantity(variant: OdooVariantSnapshot, field?: OdooStockField): number {
    return field === OdooStockField.QtyAvailable ? variant.qtyAvailable : variant.freeQty;
  }

  private async fetchAttachmentsForTemplates(
    session: OdooSession,
    templateIds: number[],
    variantIds: number[],
    hasDocuments: boolean,
  ): Promise<Map<number, OdooAttachmentRecord[]>> {
    const result = new Map<number, OdooAttachmentRecord[]>();
    const seenAttachmentIds = new Set<number>();

    const addToTemplate = (templateId: number, record: OdooAttachmentRecord): void => {
      if (seenAttachmentIds.has(record.id)) return;
      seenAttachmentIds.add(record.id);
      const list = result.get(templateId) ?? [];
      list.push(record);
      result.set(templateId, list);
    };

    // 1. Read `product.document` records linked to product.template
    if (hasDocuments) {
      const docs = await this.safeReadModel<Record<string, unknown>>(
        session,
        'product.document',
        'search_read',
        [
          [
            ['active', '=', true],
            ['res_model', '=', 'product.template'],
            ['res_id', 'in', templateIds],
          ],
        ],
        {
          fields: [
            'id',
            'name',
            'res_id',
            'mimetype',
            'file_size',
            'ir_attachment_id',
            'type',
            'sequence',
          ],
          order: 'sequence asc, id asc',
        },
      );

      const attIds = docs.flatMap((doc) =>
        Array.isArray(doc.ir_attachment_id) ? [Number(doc.ir_attachment_id[0])] : [],
      );
      const attMap = new Map<number, Record<string, unknown>>();
      if (attIds.length > 0) {
        const atts = await this.safeReadModel<Record<string, unknown>>(
          session,
          'ir.attachment',
          'read',
          [attIds],
          { fields: ['id', 'name', 'mimetype', 'file_size', 'public', 'datas'] },
        );
        for (const att of atts) attMap.set(Number(att.id), att);
      }

      for (const doc of docs) {
        const attId = Array.isArray(doc.ir_attachment_id) ? Number(doc.ir_attachment_id[0]) : 0;
        if (!attId) continue;
        const att = attMap.get(attId);
        const templateId = Number(doc.res_id);
        addToTemplate(templateId, {
          id: attId,
          documentId: Number(doc.id),
          name: optionalText(doc.name) ?? optionalText(att?.name) ?? `attachment-${attId}`,
          mimetype:
            optionalText(att?.mimetype) ?? optionalText(doc.mimetype) ?? 'application/octet-stream',
          fileSize: optionalNumber(att?.file_size) ?? optionalNumber(doc.file_size),
          isPublic: Boolean(att?.public),
          datasBase64: optionalText(att?.datas),
        });
      }
    }

    // 2. Also inspect direct ir.attachment rows on product.template (excluding res_field image caches)
    const directAtts = await this.safeReadModel<Record<string, unknown>>(
      session,
      'ir.attachment',
      'search_read',
      [
        [
          ['res_model', '=', 'product.template'],
          ['res_id', 'in', templateIds],
          ['res_field', '=', false],
          ['type', '=', 'binary'],
        ],
      ],
      { fields: ['id', 'name', 'res_id', 'mimetype', 'file_size', 'public', 'datas'] },
    );

    for (const att of directAtts) {
      const attId = Number(att.id);
      const templateId = Number(att.res_id);
      addToTemplate(templateId, {
        id: attId,
        documentId: null,
        name: optionalText(att.name) ?? `attachment-${attId}`,
        mimetype: optionalText(att.mimetype) ?? 'application/octet-stream',
        fileSize: optionalNumber(att.file_size),
        isPublic: Boolean(att.public),
        datasBase64: optionalText(att.datas),
      });
    }

    // Keep variantIds referenced cleanly (future variant-level attachments if present)
    void variantIds;

    return result;
  }

  private resolveBrandField(
    fields: Record<string, OdooFieldMeta>,
    configured?: string | null,
  ): string | null {
    if (configured && configured in fields) return configured;
    return BRAND_FIELD_CANDIDATES.find((candidate) => candidate in fields) ?? null;
  }

  private extractBrandValue(value: unknown): string | null {
    if (Array.isArray(value)) return many2OneName(value as Many2OneValue);
    return optionalText(value);
  }

  private async modelExists(session: OdooSession, model: string): Promise<boolean> {
    try {
      await this.executeRead(session, model, 'fields_get', [], { attributes: ['type'] });
      return true;
    } catch {
      return false;
    }
  }

  private async safeReadModel<Row>(
    session: OdooSession,
    model: string,
    method: 'search_read' | 'read',
    args: unknown[],
    kwargs?: Record<string, unknown>,
  ): Promise<Row[]> {
    try {
      return await this.readModel<Row>(session, model, method, args, kwargs);
    } catch {
      return [];
    }
  }

  private readModel<Row>(
    session: OdooSession,
    model: string,
    method: 'search_read' | 'read',
    args: unknown[],
    kwargs?: Record<string, unknown>,
  ): Promise<Row[]> {
    return this.executeRead<Row[]>(session, model, method, args, kwargs);
  }

  private executeRead<Result>(
    session: OdooSession,
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<Result> {
    if (!ODOO_READ_ONLY_METHODS.has(method)) {
      throw new Error(`Blocked non-read-only Odoo RPC method: ${method}`);
    }
    return this.jsonRpc<Result>(session.url, 'object', 'execute_kw', [
      session.database,
      session.uid,
      session.apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  private async jsonRpc<Result>(
    url: string,
    service: 'common' | 'object',
    method: string,
    args: unknown[],
  ): Promise<Result> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ODOO_RPC_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: { service, method, args },
          id: Date.now(),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Odoo HTTP ${response.status}`);
      }
      const payload = (await response.json()) as JsonRpcResponse<Result>;
      if (payload.error) {
        const message =
          payload.error.data?.message || payload.error.message || 'Odoo RPC call failed';
        throw new Error(message);
      }
      return payload.result as Result;
    } finally {
      clearTimeout(timer);
    }
  }
}
