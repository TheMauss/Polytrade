/** Polymarket CLOB API client for order book data and trading. */

import { createHmac } from "crypto";
import { logger } from "../utils/logger.js";
import type { Credentials } from "../config.js";
import type { OrderBook, OrderBookLevel } from "./types.js";

const CLOB_BASE_URL = "https://clob.polymarket.com";

export class ClobClient {
  private baseUrl: string;
  private credentials: Credentials | null;

  constructor(credentials?: Credentials, baseUrl = CLOB_BASE_URL) {
    this.baseUrl = baseUrl;
    this.credentials = credentials ?? null;
  }

  private buildAuthHeaders(method: string, path: string, body = ""): Record<string, string> {
    if (!this.credentials?.apiKey) return {};

    const timestamp = String(Math.floor(Date.now() / 1000));
    const message = `${timestamp}${method}${path}${body}`;
    const signature = createHmac("sha256", this.credentials.secret)
      .update(message)
      .digest("hex");

    return {
      "POLY-API-KEY": this.credentials.apiKey,
      "POLY-SIGNATURE": signature,
      "POLY-TIMESTAMP": timestamp,
      "POLY-PASSPHRASE": this.credentials.passphrase,
    };
  }

  async getOrderbook(tokenId: string): Promise<OrderBook> {
    const url = new URL("/book", this.baseUrl);
    url.searchParams.set("token_id", tokenId);

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`CLOB API ${resp.status}: ${resp.statusText}`);
    const data = await resp.json() as any;

    const bids: OrderBookLevel[] = (data.bids ?? [])
      .map((b: any) => ({ price: Number(b.price), size: Number(b.size) }))
      .sort((a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price);

    const asks: OrderBookLevel[] = (data.asks ?? [])
      .map((a: any) => ({ price: Number(a.price), size: Number(a.size) }))
      .sort((a: OrderBookLevel, b: OrderBookLevel) => a.price - b.price);

    return { tokenId, bids, asks };
  }

  async getPrice(tokenId: string): Promise<number | null> {
    const book = await this.getOrderbook(tokenId);
    const bid = book.bids[0]?.price ?? null;
    const ask = book.asks[0]?.price ?? null;
    if (bid !== null && ask !== null) return (bid + ask) / 2;
    return bid ?? ask;
  }

  async getMidpoint(tokenId: string): Promise<number | null> {
    const url = new URL("/midpoint", this.baseUrl);
    url.searchParams.set("token_id", tokenId);

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`CLOB API ${resp.status}: ${resp.statusText}`);
    const data = await resp.json() as any;
    return data.mid != null ? Number(data.mid) : null;
  }

  async placeOrder(
    tokenId: string,
    side: "BUY" | "SELL",
    size: number,
    price: number,
    orderType = "GTC",
  ): Promise<any> {
    const path = "/order";
    const bodyData = {
      tokenID: tokenId,
      side,
      size: String(size),
      price: String(price),
      type: orderType,
    };
    const body = JSON.stringify(bodyData);
    const authHeaders = this.buildAuthHeaders("POST", path, body);

    const resp = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body,
    });

    if (!resp.ok) throw new Error(`Order failed ${resp.status}: ${await resp.text()}`);
    const result = await resp.json();

    logger.info({ tokenId, side, size, price, orderId: (result as any).orderID }, "order_placed");
    return result;
  }

  /** Fetch the fee rate in basis points for a given token. Returns 0 if no fees. */
  async getFeeRateBps(tokenId: string): Promise<number> {
    const url = new URL("/fees", this.baseUrl);
    url.searchParams.set("token_id", tokenId);

    try {
      const resp = await fetch(url);
      if (!resp.ok) return 0;
      const data = await resp.json() as any;
      return Number(data.fee_rate_bps ?? 0);
    } catch {
      return 0; // Default to 0 if endpoint unavailable
    }
  }

  async getOpenOrders(): Promise<any[]> {
    const path = "/orders";
    const authHeaders = this.buildAuthHeaders("GET", path);

    const resp = await fetch(new URL(path, this.baseUrl), {
      headers: authHeaders,
    });
    if (!resp.ok) return [];
    return (await resp.json()) as any[];
  }

  async cancelOrder(orderId: string): Promise<any> {
    const path = `/order/${orderId}`;
    const authHeaders = this.buildAuthHeaders("DELETE", path);

    const resp = await fetch(new URL(path, this.baseUrl), {
      method: "DELETE",
      headers: authHeaders,
    });

    if (!resp.ok) throw new Error(`Cancel failed ${resp.status}: ${await resp.text()}`);
    logger.info({ orderId }, "order_cancelled");
    return resp.json();
  }
}
