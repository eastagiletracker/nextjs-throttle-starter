import "server-only"

import type {
  AddLineItemInput,
  Cart as SdkCart,
  CartAddress,
  LineItem as SdkLineItem,
} from "@usethrottle/cart"
import { callThrottle } from "./client"
import { getCartClient, requireStoreId } from "./clients"
import type { ThrottleAddress, ThrottleCart, ThrottleLineItem } from "./types"

// Adapters between the SDK's shapes and the starter's existing types.
// Keeping a thin translation layer lets the public surface of this module
// (createCart, addCartItem, …) stay stable even if the SDK rev bumps its
// field names.

function sdkCartToThrottleCart(c: SdkCart): ThrottleCart {
  return {
    id: c.id,
    status: c.status,
    currency: c.currency,
    subtotal: c.subtotal,
    taxTotal: c.taxTotal,
    discountTotal: c.discountTotal,
    shippingTotal: c.shippingTotal,
    total: c.total,
    shippingAddress: (c.shippingAddress as ThrottleAddress) ?? null,
    billingAddress: (c.billingAddress as ThrottleAddress) ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

function sdkLineItemToThrottle(li: SdkLineItem): ThrottleLineItem {
  return {
    id: li.id,
    cartId: li.cartId ?? null,
    orderId: null, // SDK's LineItem type ties to carts only
    type: li.type,
    referenceId: li.referenceId,
    name: li.name,
    description: li.description,
    unitPrice: li.unitPrice,
    quantity: li.quantity,
    subtotal: li.subtotal,
    taxAmount: li.taxAmount,
    discountAmount: li.discountAmount,
    total: li.total,
    imageUrl: li.imageUrl,
    position: li.position,
    metadata: li.metadata,
  }
}

/**
 * Map the starter's ThrottleAddress (line1/state/country) onto Throttle's
 * canonical `CartAddress` (addressLine1/stateProvince/countryCode). As of
 * @usethrottle/cart 3.6 `UpdateCartInput.shippingAddress` is typed as
 * `CartAddress` (no longer a loose record) and the API validates required
 * fields at write time — so a field-name mismatch is now caught here at
 * compile time and, failing that, rejected on write rather than surfacing as a
 * 422 `address_required` at `complete`. Required fields fall back to "" so an
 * incomplete address trips that write-time validation instead of silently
 * persisting a partial one.
 */
function toCartAddressPayload(addr: ThrottleAddress): CartAddress {
  return {
    firstName: addr.firstName,
    lastName: addr.lastName,
    addressLine1: addr.line1 ?? "",
    addressLine2: addr.line2,
    city: addr.city ?? "",
    stateProvince: addr.state,
    postalCode: addr.postalCode,
    countryCode: (addr.country ?? "").toUpperCase(),
    phone: addr.phone,
    email: addr.email,
  }
}

export interface CreateCartInput {
  externalId?: string
  /** Throttle customer the cart (and the order it becomes) belongs to. Take
   *  it from the authenticated session, never from the request body. */
  customerId?: string
  customerEmail?: string
  shippingAddress?: ThrottleAddress
  billingAddress?: ThrottleAddress
  metadata?: Record<string, unknown>
}

export async function createCart(input: CreateCartInput = {}): Promise<ThrottleCart> {
  // Carts belong to an application (store). THROTTLE_STORE_ID holds that
  // application's uuid.
  const sdk = await callThrottle(() =>
    getCartClient().carts.create({
      applicationId: requireStoreId(),
      currency: "USD",
      ...(input.customerId ? { customerId: input.customerId } : {}),
      metadata: {
        ...(input.externalId ? { externalId: input.externalId } : {}),
        ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
        ...(input.metadata ?? {}),
      },
    })
  )
  // Addresses aren't part of the create payload — set them with a
  // follow-up update when the caller supplies them.
  if (input.shippingAddress || input.billingAddress) {
    const patched = await callThrottle(() =>
      getCartClient().carts.update(sdk.id, {
        shippingAddress: input.shippingAddress
          ? toCartAddressPayload(input.shippingAddress)
          : undefined,
        billingAddress: input.billingAddress
          ? toCartAddressPayload(input.billingAddress)
          : undefined,
      })
    )
    return sdkCartToThrottleCart(patched)
  }
  return sdkCartToThrottleCart(sdk)
}

/**
 * Set the shipping address on an existing cart (e.g. the open cart the buyer
 * built up via add-to-cart) so a cart-backed order carries the right
 * destination. The buyer's email rides on the checkout session instead.
 */
export async function setCartShippingAddress(
  cartId: string,
  shippingAddress: ThrottleAddress
): Promise<void> {
  await callThrottle(() =>
    getCartClient().carts.update(cartId, {
      shippingAddress: toCartAddressPayload(shippingAddress),
    })
  )
}

/**
 * Link an existing cart to a Throttle customer, so the order it becomes on
 * payment carries the customer and shows up in that buyer's order history
 * (`listOrders({ customerId })`). The buyer usually builds the cart before
 * signing in, so this runs at checkout rather than at cart creation. The id
 * must come from the authenticated session, never from the request body.
 */
export async function setCartCustomer(
  cartId: string,
  customerId: string
): Promise<void> {
  await callThrottle(() => getCartClient().carts.update(cartId, { customerId }))
}

export interface AddCartItemInput {
  name: string
  unitPrice: number
  quantity: number
  referenceId?: string
  description?: string
  imageUrl?: string
  metadata?: Record<string, unknown>
}

export async function addCartItem(
  cartId: string,
  item: AddCartItemInput
): Promise<ThrottleLineItem> {
  const sdkInput: AddLineItemInput = {
    name: item.name,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    referenceId: item.referenceId,
    description: item.description,
    imageUrl: item.imageUrl,
    metadata: item.metadata,
  }
  const li = await callThrottle(() => getCartClient().items.add(cartId, sdkInput))
  return sdkLineItemToThrottle(li)
}

export function addCartItems(
  cartId: string,
  items: AddCartItemInput[]
): Promise<ThrottleLineItem[]> {
  return Promise.all(items.map((item) => addCartItem(cartId, item)))
}

export interface UpdateCartItemInput {
  quantity?: number
  unitPrice?: number
}

export async function updateCartItem(
  cartId: string,
  itemId: string,
  input: UpdateCartItemInput
): Promise<ThrottleLineItem> {
  const li = await callThrottle(() =>
    getCartClient().items.update(cartId, itemId, input)
  )
  return sdkLineItemToThrottle(li)
}

export function removeCartItem(cartId: string, itemId: string): Promise<void> {
  return callThrottle(() => getCartClient().items.remove(cartId, itemId))
}

export async function getCart(cartId: string): Promise<ThrottleCart> {
  const sdk = await callThrottle(() => getCartClient().carts.get(cartId))
  return sdkCartToThrottleCart(sdk)
}

/**
 * The cart's line items, mapped to our domain shape. Used to hydrate an
 * order's display when the order record keeps its items on the cart rather
 * than snapshotting them onto `order.lineItems`.
 */
export async function getCartLineItems(
  cartId: string
): Promise<ThrottleLineItem[]> {
  const sdk = await callThrottle(() => getCartClient().carts.get(cartId))
  const items = (sdk as { lineItems?: SdkLineItem[] }).lineItems ?? []
  return items.map(sdkLineItemToThrottle)
}

export interface AppliedDiscount {
  code: string
  amount: number
  currency: string
  type: "percentage" | "fixed_amount"
  freeShipping: boolean
}

function appliedDiscountFromCart(cart: SdkCart): AppliedDiscount | null {
  const d = cart.appliedDiscount
  if (!d) return null
  return {
    code: d.code,
    amount: d.amount,
    currency: d.currency,
    type: d.type,
    freeShipping: d.freeShipping,
  }
}

export async function applyDiscount(
  cartId: string,
  code: string
): Promise<{
  cart: ThrottleCart
  discount: AppliedDiscount | null
}> {
  const sdk = await callThrottle(() =>
    getCartClient().discounts.apply(cartId, code)
  )
  return {
    cart: sdkCartToThrottleCart(sdk),
    discount: appliedDiscountFromCart(sdk),
  }
}

export async function removeDiscount(cartId: string): Promise<ThrottleCart> {
  const sdk = await callThrottle(() => getCartClient().discounts.remove(cartId))
  return sdkCartToThrottleCart(sdk)
}
