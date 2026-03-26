export const PROXY_MARKET_PATTERNS: RegExp[] = [
  // Commodity / index price bracket markets are price bets, not causal catalysts
  /will .+ (settle|close|end|finish) (above|below|at) \$/i,
  /\b(CL|ES|NQ|GC|SI|HG)\b.+(settle|above|below)/i,
  /price of .+ (above|below|over|under) \$/i,
  /\b(settle|settling)\b.+\b(above|below)\b/i,
  /\bclose (above|below|over|under)\b/i,
  /\bfinish (above|below|over|under)\b/i,
  /\bend (above|below|over|under) \$/i,
  /will .+\b(reach|hit|touch|cross)\b.+\$[\d,]+/i,
  /\$\d+[\s-]+\$\d+/i,
  /\b(crude oil|wti|brent|s&p 500|sp500|nasdaq|dow|gold|silver|bitcoin|ethereum|btc|eth)\b.+\b(hit|reach|touch|cross)\b.+\$[\d,]+/i,
  /\b(CL|ES|NQ|GC|SI|HG)\b.+\b(hit|reach|touch|cross)\b.+\$[\d,]+/i,
  // Broad crypto target noise
  /\b(bitcoin|ethereum|btc|eth)\b.+\b(price|reach|hit|touch|cross)\b.+\$[\d,]+/i,
  /\b(bitcoin|ethereum|btc|eth)\b.+\b(above|below|over|under)\b.+\$?[\d,]+/i
];

// Markets matching these patterns are entertainment/gambling with no stock-price signal value.
export const NOISE_PATTERNS: RegExp[] = [
  /will .+ post \d+.+tweets/i,
  /will .+ tweet .+ times/i,
  /how many .+ tweets/i,
  /will .+ reach \d+ followers/i,
  /price of .+ on .+ at/i,
  /will .+ score \d+/i,
  /will .+ win .+ game/i,
  /temperature/i,
  /subscriber/i,
  /\bviews\b/i,
  // Crypto meme / token noise
  /\$[A-Z]{2,10}\s+reach\s+\$/i,
  /listed on binance/i,
  /listed on coinbase/i,
  /memecoin/i,
  /meme coin/i,
  /token (launch|listing|price)/i,
  /nft (floor|price|volume)/i,
  // Streaming / social media
  /will .+ (stream|viewers|viewership)/i,
  /youtube|twitch|tiktok/i,
  // Entertainment
  /\b(superbowl|super bowl|oscar|grammy|emmy)\b/i,
  /box office/i,
  /album sales/i,
  /\bdating\b/i,
  /baby|pregnant|marriage|divorce/i,
  /reality\s*tv/i,
  /will .+ die /i,
  /onlyfans/i,
  /mukbang/i,
  // Entertainment / celebrity
  /bridgerton/i,
  /release an? (new )?(album|single|ep|song)/i,
  /album before gta vi/i,
  /\b(film|movie|season \d|episode)\b/i,
  /#1 hit|\bnumber one hit\b/i,
  /taylor swift|beyonce|drake|kanye|rihanna/i,
  /celebrity|famous|influencer/i,
  /\b(nba|nfl|nhl|mlb|fifa|champions league)\b/i,
  /will .+ (score|win|beat|defeat|qualify)/i,
  /\bpenguin\b/i,
  /\bmemecoin\b|\bshitcoin\b/i,
  /\$[A-Z]{3,10} (hit|reach|touch|cross) \$/i,
  // Music charts (mention streaming services but are NOT about the company)
  /be the (top|\#\d+) (song|artist|track|album|show|movie) on/i,
  /monthly (spotify|apple music) listeners/i,
  /top spotify artist/i,
  // Podcast / media appearances (not market-moving)
  /appear on .+ (podcast|show|stream)/i,
  /\b(podcast|episode|interview|livestream)\b.*(by|before|december|january)/i,
  /uponly|bankless pod|unchained pod/i,
  /joe rogan/i,
  // More entertainment/social noise
  /\bfollowers?\b.*\b(million|thousand|[0-9]+[mk])\b/i,
  /\bretweet|like|subscribe|view count\b/i,
  /will .+ (join|leave|sign with|transfer to)/i,
  /\b(grammy|emmy|oscar|tony|golden globe)\s*(award|winner|nominee)/i,
  /\brap\s*beef\b|\bdiss\s*track\b/i,
  /\bbreakup\b|\brelationship\b.*\bcelebrit/i,
  /^[A-Z]{2,5}:\s.+\svs\.\s.+/i,
  // State-level sportsbook/operator enforcement is not actionable for this asset universe
  /\brevoke any osb license\b/i,
  /\bevent-contract activity\b/i,
  // Climate/science and speech word-count markets are not actionable here
  /minimum arctic sea ice extent/i,
  /^will .+ say ["“].+["”].*(during|before|at)/i,
  /\b\d+\+\s*times\b.*\b(speech|remarks|press conference|event)\b/i,
  /\b(powell|jerome powell)\b.*\bsay\b.*\bpress conference\b/i,
  /\bpress conference\b.*\b(say|times)\b/i,
  // Micro-timebox crypto markets (5-15 min windows, pure noise)
  /\b(bitcoin|ethereum|solana|btc|eth|sol|bnb|doge|xrp)\b.+up or down/i,
  /up or down\s*-\s*\w+\s+\d+.*\d{1,2}:\d{2}\s*(am|pm)/i,
  ...PROXY_MARKET_PATTERNS
];

export function isNoiseMarketQuestion(question: string): boolean {
  return NOISE_PATTERNS.some(pattern => pattern.test(question));
}

export function isProxyPriceMarket(question: string): boolean {
  return PROXY_MARKET_PATTERNS.some(pattern => pattern.test(question));
}
