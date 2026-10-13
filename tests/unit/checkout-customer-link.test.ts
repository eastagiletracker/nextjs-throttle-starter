import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// Throttle env must be present before @/lib/env is evaluated, so the
// @/lib/checkout barrel picks the Throttle provider rather than the demo one.
const { cartClient, checkoutClient, getCurrentUser, after, saveAddressIfNew } = vi.hoisted(() => {
  process.env.THROTTLE_API_KEY = "sk_test_unit"
  process.env.THROTTLE_STORE_ID = "11111111-1111-4111-8111-111111111111"
  return {
    cartClient: {
      carts: { create: vi.fn(), get: vi.fn(), update: vi.fn() },
      items: { add: vi.fn() },
    },
    checkoutClient: { createSession: vi.fn() },
    getCurrentUser: vi.fn(),
    after: vi.fn(),
    saveAddressIfNew: vi.fn(),
  }
})

vi.mock("@/lib/throttle/clients", () => ({
  getCartClient: () => cartClient,
  getCheckoutClient: () => checkoutClient,
  requireStoreId: () => "11111111-1111-4111-8111-111111111111",
}))
vi.mock("@/lib/auth", () => ({
  authProvider: { getCurrentUser },
  isClerkConfigured: true,
}))
// The address auto-save is fire-and-forget after the response; keep it inert.
vi.mock("@/lib/throttle/customer-addresses", () => ({ saveAddressIfNew }))
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after,
}))

import { POST } from "@/app/api/throttle/checkout-session/route"

const OPEN_CART_ID = "22222222-2222-4222-8222-222222222222"
const FRESH_CART_ID = "33333333-3333-4333-8333-333333333333"

const item = {
  id: "v1",
  variantId: "v1",
  productId: "p1",
  name: "Mug",
  variantName: "Blue",
  image: { url: "https://example.com/mug.png", alt: "Mug" },
  slug: "mug",
  price: 1500,
  quantity: 2,
  lineTotal: 3000,
}

const customer = {
  email: "buyer@example.com",
  shippingAddress: {
    firstName: "Ada",
    lastName: "Lovelace",
    line1: "1 Main St",
    city: "Portland",
    state: "OR",
    postalCode: "97201",
    country: "US",
  },
}

function sdkCart(id: string, status = "open") {
  return {
    id,
    status,
    currency: "USD",
    subtotal: 3000,
    taxTotal: 0,
    discountTotal: 0,
    shippingTotal: 0,
    total: 3000,
    shippingAddress: null,
    billingAddress: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  }
}

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3000/api/throttle/checkout-session", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  )
}

/** Every customerId the route sent to Throttle's cart API, in call order. */
function customerIdsSentToCart(): unknown[] {
  return [
    ...cartClient.carts.create.mock.calls.map(([input]) => input.customerId),
    ...cartClient.carts.update.mock.calls.map(([, input]) => input.customerId),
  ].filter((v) => v !== undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  cartClient.carts.get.mockResolvedValue(sdkCart(OPEN_CART_ID))
  cartClient.carts.create.mockResolvedValue(sdkCart(FRESH_CART_ID))
  cartClient.carts.update.mockImplementation(async (id: string) => sdkCart(id))
  cartClient.items.add.mockResolvedValue({ id: "li_1", type: "product" })
  checkoutClient.createSession.mockResolvedValue({
    sessionId: "cs_unit",
    embedUrl: "https://checkout.example/embed",
  })
})

describe("POST /api/throttle/checkout-session — customer linking", () => {
  it("links the reused open cart to the signed-in buyer's Throttle customer", async () => {
    getCurrentUser.mockResolvedValue({
      id: "user_1",
      email: "buyer@example.com",
      throttleCustomerId: "cus_signed_in",
    })

    const res = await post({ items: [item], customer, throttleCartId: OPEN_CART_ID })

    expect(res.status).toBe(201)
    expect(cartClient.carts.update).toHaveBeenCalledWith(
      OPEN_CART_ID,
      expect.objectContaining({ customerId: "cus_signed_in" })
    )
    // The cart must be linked before the session that turns it into an order.
    const linkOrder = cartClient.carts.update.mock.invocationCallOrder.at(-1)!
    expect(linkOrder).toBeLessThan(
      checkoutClient.createSession.mock.invocationCallOrder[0]
    )
    expect(checkoutClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cartId: OPEN_CART_ID })
    )
  })

  it("creates a fresh cart already linked when there is no reusable cart", async () => {
    getCurrentUser.mockResolvedValue({
      id: "user_1",
      email: "buyer@example.com",
      throttleCustomerId: "cus_signed_in",
    })

    const res = await post({ items: [item], customer })

    expect(res.status).toBe(201)
    expect(cartClient.carts.create).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_signed_in" })
    )
    expect(checkoutClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cartId: FRESH_CART_ID })
    )
  })

  it("links the replacement cart when the persisted one was already converted", async () => {
    cartClient.carts.get.mockResolvedValue(sdkCart(OPEN_CART_ID, "converted"))
    getCurrentUser.mockResolvedValue({
      id: "user_1",
      email: "buyer@example.com",
      throttleCustomerId: "cus_signed_in",
    })

    const res = await post({ items: [item], customer, throttleCartId: OPEN_CART_ID })

    expect(res.status).toBe(201)
    expect(cartClient.carts.create).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_signed_in" })
    )
    expect(customerIdsSentToCart()).toEqual(["cus_signed_in"])
  })

  it("leaves a guest checkout unlinked", async () => {
    getCurrentUser.mockResolvedValue(null)

    const res = await post({ items: [item], customer, throttleCartId: OPEN_CART_ID })

    expect(res.status).toBe(201)
    expect(customerIdsSentToCart()).toEqual([])
  })

  it("leaves a signed-in buyer with no Throttle customer unlinked", async () => {
    getCurrentUser.mockResolvedValue({ id: "user_2", email: "" })

    const res = await post({ items: [item], customer, throttleCartId: OPEN_CART_ID })

    expect(res.status).toBe(201)
    expect(customerIdsSentToCart()).toEqual([])
  })

  it("never takes the customer id from the request body", async () => {
    getCurrentUser.mockResolvedValue(null)

    const res = await post({
      items: [item],
      customer: { ...customer, customerId: "cus_victim" },
      customerId: "cus_victim",
      throttleCartId: OPEN_CART_ID,
    })

    expect(res.status).toBe(201)
    expect(customerIdsSentToCart()).toEqual([])
  })

  it("still checks out as a guest when resolving the buyer fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    getCurrentUser.mockRejectedValue(new Error("clerk down"))

    const res = await post({ items: [item], customer, throttleCartId: OPEN_CART_ID })

    expect(res.status).toBe(201)
    expect(customerIdsSentToCart()).toEqual([])
    expect(checkoutClient.createSession).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("still saves a signed-in buyer's address to the same customer after the response", async () => {
    getCurrentUser.mockResolvedValue({
      id: "user_1",
      email: "buyer@example.com",
      throttleCustomerId: "cus_signed_in",
    })

    const res = await post({ items: [item], customer, throttleCartId: OPEN_CART_ID })
    expect(res.status).toBe(201)
    expect(after).toHaveBeenCalledTimes(1)

    await after.mock.calls[0][0]()
    expect(saveAddressIfNew).toHaveBeenCalledWith(
      "cus_signed_in",
      expect.objectContaining({ line1: "1 Main St", postalCode: "97201" })
    )
    // One auth lookup serves both the cart link and the address save.
    expect(getCurrentUser).toHaveBeenCalledTimes(1)
  })

  it("schedules no address save for a guest", async () => {
    getCurrentUser.mockResolvedValue(null)

    await post({ items: [item], customer, throttleCartId: OPEN_CART_ID })

    expect(after).not.toHaveBeenCalled()
  })
})
