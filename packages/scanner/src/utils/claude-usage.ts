let aiCliCallsToday = 0;
let lastResetDate = '';

export function trackAiCliCall(context: string): void {
  const today = new Date().toISOString().split('T')[0];
  if (today !== lastResetDate) {
    aiCliCallsToday = 0;
    lastResetDate = today;
  }
  aiCliCallsToday++;
  const provider = (process.env.LOCAL_AI_PROVIDER || 'claude').toLowerCase() === 'openai'
    ? 'openai'
    : 'claude';
  console.log(`  [ai-cli:${provider}] call #${aiCliCallsToday} today (${context})`);
}

export function getAiCliUsage(): { today: number; provider: string } {
  return {
    today: aiCliCallsToday,
    provider: (process.env.LOCAL_AI_PROVIDER || 'claude').toLowerCase() === 'openai'
      ? 'openai'
      : 'claude'
  };
}

export function trackClaudeCall(context: string): void {
  trackAiCliCall(context);
}

export function getClaudeUsage(): { today: number } {
  return { today: aiCliCallsToday };
}
