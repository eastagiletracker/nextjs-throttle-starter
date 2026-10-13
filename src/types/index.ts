// ============================================================================
// Core Ecommerce Types — Backend-Agnostic Data Contract
// ============================================================================

// --- Brand ---

export interface Brand {
  id: string
  name: string
  slug: string
  description: string
}

// --- CMS-style Pages ---

export interface CmsPage {
  id: string
  title: string
  slug: string
  /** Short summary shown on the pages index */
  excerpt?: string
  /** Markdown content, rendered with <MarkdownContent /> (.blog-body prose) */
  body: string
  publishedAt: string
  updatedAt?: string
}

// --- Blog Posts ---

export interface BlogPost {
  id: string
  title: string
  slug: string
  excerpt: string
  body: string
  author: string
  tags: string[]
  coverImage?: ProductImage
  publishedAt: string
  updatedAt?: string
}

// --- Product ---

export type ProductStatus = "draft" | "active" | "archived"

export interface ProductImage {
  url: string
  alt: string
  width?: number
  height?: number
}

export interface ProductOption {
  name: string // e.g., "Color", "Size"
  value: string // e.g., "Black", "M"
}

export interface VariantInventory {
  quantity: number
  trackInventory: boolean
  allowBackorder: boolean
}

export interface ProductVariant {
  id: string
  productId: string
  sku: string
  /**
   * Variant label, e.g. "Large / Black". Use the sentinel "Default" for a
   * single-variant product: the cart lines suppress exactly that value, so a
   * source that fills this with the product title prints the name twice.
   */
  name: string
  price: number // in cents
  /**
   * True when the source says the item exists but has NO price (made to order,
   * awaiting costing, quote-only). `price` is then meaningless - do not render
   * it, do not publish it in OG tags or schema.org offers, and do not let the
   * item reach the cart. Check it through `isUnpriced()` in src/lib/pricing.ts
   * rather than comparing `price` to 0: zero is a price claim, absence is not.
   */
  unpriced?: boolean
  compareAtPrice?: number // original price for sale display
  currency: string
  inventory: VariantInventory
  options: ProductOption[]
  images: ProductImage[]
  weight?: number
  dimensions?: { length: number; width: number; height: number }
}

export interface Product {
  id: string
  name: string
  slug: string
  /** Short blurb shown in the product info column (1–2 sentences) */
  description: string
  /** Full HTML description shown below gallery/add-to-cart (.blog-body prose) */
  body?: string
  images: ProductImage[]
  status: ProductStatus
  brandId: string
  categoryIds: string[]
  tags: string[]
  variants: ProductVariant[]
  rating: number
  reviewCount: number
  featured: boolean
  createdAt: string
  updatedAt: string
}

// --- Category ---

export interface Category {
  id: string
  name: string
  slug: string
  description: string
  image?: ProductImage
  parentId?: string
  order: number
}

// --- Cart ---

export interface CartItem {
  id: string
  variantId: string
  productId: string
  name: string
  variantName: string
  image: ProductImage
  slug: string
  price: number
  quantity: number
  lineTotal: number
}

export interface Cart {
  id: string
  items: CartItem[]
  subtotal: number
  tax: number
  shipping: number
  total: number
  itemCount: number
}

// --- Order ---

export type OrderStatus =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded"

export type PaymentStatus =
  | "pending"
  | "authorized"
  | "captured"
  | "failed"
  | "refunded"

export interface OrderLineItem {
  id: string
  productId: string
  variantId: string
  name: string
  variantName: string
  sku: string
  image: ProductImage
  price: number
  quantity: number
  total: number
}

export interface Order {
  id: string
  orderNumber: string
  userId?: string
  items: OrderLineItem[]
  status: OrderStatus
  paymentStatus: PaymentStatus
  subtotal: number
  tax: number
  shipping: number
  total: number
  currency: string
  shippingAddress: Address
  billingAddress?: Address
  customerEmail: string
  customerName: string
  createdAt: string
  updatedAt: string
}

// --- User ---

export type UserRole = "customer" | "admin"

export interface User {
  id: string
  email: string
  firstName: string
  lastName: string
  role: UserRole
  addresses: Address[]
  createdAt: string
  updatedAt: string
}

// --- Address ---

export type AddressType = "shipping" | "billing"

export interface Address {
  id: string
  type: AddressType
  firstName: string
  lastName: string
  line1: string
  line2?: string
  city: string
  state: string
  postalCode: string
  country: string
  phone?: string
  isDefault: boolean
}

// --- Payment ---

export type PaymentMethod = "card" | "bank_transfer" | "wallet" | "other"

export interface Payment {
  id: string
  orderId: string
  method: PaymentMethod
  status: PaymentStatus
  amount: number
  currency: string
  transactionId?: string
  metadata?: Record<string, string>
}

// --- Review (placeholder for v2) ---

export interface Review {
  id: string
  productId: string
  userId: string
  rating: number // 1-5
  title: string
  content: string
  verified: boolean
  createdAt: string
}

// ============================================================================
// Infrastructure Types
// ============================================================================

// --- API Response ---

export type ApiResponse<T> =
  | { data: T; error?: never }
  | { data?: never; error: ApiError }

export interface ApiError {
  code: string
  message: string
  field?: string
  details?: Record<string, string[]>
}

// --- Pagination ---

export interface PaginationParams {
  page: number
  limit: number
}

export interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface PaginatedResult<T> {
  items: T[]
  pagination: PaginationMeta
}

// --- Filtering & Sorting ---

export type SortOrder = "asc" | "desc"

export interface SortOption {
  field: string
  order: SortOrder
}

export interface PriceRange {
  min?: number
  max?: number
}

export interface ProductFilters {
  category?: string
  priceRange?: PriceRange
  inStock?: boolean
  search?: string
  tags?: string[]
}

// --- Checkout Provider ---

export interface CheckoutSession {
  id: string
  url: string
  status: "open" | "complete" | "expired"
  orderId?: string
  metadata?: Record<string, string>
}

export interface WebhookResult {
  success: boolean
  orderId?: string
  error?: string
}

export interface CheckoutProvider {
  createSession(
    cart: Cart,
    customer?: {
      email: string
      shippingAddress?: Address
      /** Optional engine-specific cart id (e.g. Throttle cart UUID) to reuse. */
      throttleCartId?: string
      /** Engine customer id of the signed-in buyer, resolved server-side from
       *  the auth session (never the request body). Absent for guests. */
      throttleCustomerId?: string
      /** Storefront URLs the checkout session returns to (engine may require). */
      returnUrl?: string
      cancelUrl?: string
    }
  ): Promise<CheckoutSession>
  /**
   * Cancel/release an open checkout session when the buyer abandons payment,
   * so the attempt is cleaned up engine-side. Idempotent; a no-op for engines
   * with no server-side session.
   */
  cancelSession(sessionId: string): Promise<void>
  handleWebhook(
    payload: unknown,
    signature: string
  ): Promise<WebhookResult>
}

// --- Data Repository Interfaces ---

export interface ProductRepository {
  list(
    filters?: ProductFilters,
    sort?: SortOption,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Product>>
  getBySlug(slug: string): Promise<Product | null>
  getById(id: string): Promise<Product | null>
  getFeatured(limit?: number): Promise<Product[]>
  getByCategory(
    categorySlug: string,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Product>>
  search(
    query: string,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Product>>
  /**
   * Resolve a variant + its parent product by variant id. Used by the
   * server-side cart routes to price items authoritatively — never trust
   * the client for unitPrice.
   */
  findVariant(
    variantId: string
  ): Promise<{ product: Product; variant: ProductVariant } | null>
}

export interface CategoryRepository {
  list(): Promise<Category[]>
  getBySlug(slug: string): Promise<Category | null>
  getById(id: string): Promise<Category | null>
}

export interface OrderRepository {
  list(
    userId?: string,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Order>>
  getById(id: string): Promise<Order | null>
  create(order: Omit<Order, "id" | "createdAt" | "updatedAt">): Promise<Order>
  updateStatus(id: string, status: OrderStatus): Promise<Order>
}
