/** Core data types for Polymarket entities and arbitrage. */

export type Side = "YES" | "NO";
export type ArbType = "intra_event" | "cross_event";

export interface Outcome {
  tokenId: string;
  name: string;
  price: number; // 0-1 implied probability
  side: Side;
}

export interface Market {
  id: string;
  conditionId: string;
  question: string;
  outcomes: Outcome[];
  eventId: string;
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  endDate?: string;
}

export interface Event {
  id: string;
  title: string;
  slug: string;
  markets: Market[];
  category: string;
  tags: string[];
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export function bestBid(book: OrderBook): number | null {
  return book.bids.length > 0 ? book.bids[0].price : null;
}

export function bestAsk(book: OrderBook): number | null {
  return book.asks.length > 0 ? book.asks[0].price : null;
}

export function spread(book: OrderBook): number | null {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  return bid !== null && ask !== null ? ask - bid : null;
}

export interface ArbitrageOpportunity {
  id: string;
  arbType: ArbType;
  markets: Market[];
  prices: number[]; // YES prices per market
  combinedProb: number;
  grossEdgePct: number;
  netEdgePct: number;
  detectedAt: Date;
}

export interface PositionLeg {
  marketId: string;
  tokenId: string;
  side: Side;
  entryPrice: number;
  size: number; // USD
  currentPrice: number;
}

export function legPnl(leg: PositionLeg): number {
  if (leg.entryPrice === 0) return 0;
  const diff =
    leg.side === "YES"
      ? leg.currentPrice - leg.entryPrice
      : leg.entryPrice - leg.currentPrice;
  return diff * (leg.size / leg.entryPrice);
}

export interface ArbitragePosition {
  id: string;
  arbType: ArbType;
  legs: PositionLeg[];
  openedAt: Date;
  entryEdgePct: number;
}

export function positionPnl(pos: ArbitragePosition): number {
  return pos.legs.reduce((sum, leg) => sum + legPnl(leg), 0);
}

export function positionInvested(pos: ArbitragePosition): number {
  return pos.legs.reduce((sum, leg) => sum + leg.size, 0);
}

export function currentEdgePct(pos: ArbitragePosition): number {
  const total = pos.legs.reduce((sum, leg) => sum + leg.currentPrice, 0);
  return (total - 1.0) * 100;
}
