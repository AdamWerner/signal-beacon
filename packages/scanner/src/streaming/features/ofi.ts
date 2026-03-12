export interface OfiInputs {
  prevBidPrice: number;
  prevBidSize: number;
  prevAskPrice: number;
  prevAskSize: number;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  signedTradeImbalance: number;
}

export function computeOfiProxy(inputs: OfiInputs): number {
  let bidFlow = 0;
  let askFlow = 0;

  if (inputs.bidPrice > inputs.prevBidPrice) {
    bidFlow += inputs.bidSize;
  } else if (inputs.bidPrice < inputs.prevBidPrice) {
    bidFlow -= inputs.prevBidSize;
  } else {
    bidFlow += inputs.bidSize - inputs.prevBidSize;
  }

  if (inputs.askPrice < inputs.prevAskPrice) {
    askFlow += inputs.askSize;
  } else if (inputs.askPrice > inputs.prevAskPrice) {
    askFlow -= inputs.prevAskSize;
  } else {
    askFlow += inputs.askSize - inputs.prevAskSize;
  }

  return bidFlow - askFlow + inputs.signedTradeImbalance;
}

