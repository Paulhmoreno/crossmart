export interface WooMetaEntry {
  id?: number;
  key: string;
  value: unknown;
}

export interface WooImage {
  id?: number;
  src: string;
  name?: string;
  alt?: string;
}

export interface WooCategoryRef {
  id: number;
  name?: string;
  slug?: string;
}

export interface WooTagRef {
  id: number;
  name?: string;
  slug?: string;
}

export interface WooProductAttribute {
  id?: number;
  name: string;
  position?: number;
  visible?: boolean;
  variation?: boolean;
  options: string[];
}

export interface WooVariationAttribute {
  id?: number;
  name: string;
  option: string;
}

export interface WooDimensions {
  length?: string;
  width?: string;
  height?: string;
}

export interface WooProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  type: string;
  status: string;
  description: string;
  short_description: string;
  sku: string;
  global_unique_id?: string;
  price: string;
  regular_price: string;
  sale_price: string;
  tax_status?: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  backorders: string;
  weight: string;
  dimensions?: WooDimensions;
  shipping_required?: boolean;
  categories?: WooCategoryRef[];
  tags?: WooTagRef[];
  images?: WooImage[];
  attributes?: WooProductAttribute[];
  variations?: number[];
  meta_data?: WooMetaEntry[];
}

export interface WooVariation {
  id: number;
  sku: string;
  global_unique_id?: string;
  price: string;
  regular_price: string;
  sale_price: string;
  tax_status?: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  backorders: string;
  weight: string;
  attributes: WooVariationAttribute[];
  image?: WooImage | null;
}

export interface WooCategory {
  id: number;
  name: string;
  slug: string;
  parent: number;
}

export interface WooAttribute {
  id: number;
  name: string;
  slug: string;
}

export interface WooAttributeTerm {
  id: number;
  name: string;
  slug: string;
}

export interface WooSettingRow {
  id: string;
  value: unknown;
}

export interface WooOrderLineItem {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  sku: string;
  price: number | string;
  subtotal?: string;
  total?: string;
}

export interface WooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  date_created_gmt: string;
  date_modified_gmt: string;
  total: string;
  line_items: WooOrderLineItem[];
}

export interface WordPressMediaResponse {
  id: number;
  source_url: string;
  alt_text?: string;
}

export interface WordPressCurrentUser {
  id: number;
  name?: string;
  capabilities?: Record<string, boolean>;
}
