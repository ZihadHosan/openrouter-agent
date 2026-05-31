import { AgentMode } from './agent';
import { modelSupportsVision } from './attachments';

export interface AutoPickContext {
  mode: AgentMode;
  userMessage: string;
  conversationLength?: number;
  hasVisionAttachments?: boolean;
}

const VISION = /gemini|gpt-4o|gpt-4\.1|gpt-5|claude|llava|vision|pixtral|qwen-vl|internvl|glm-4v|moondream|llama-3\.2-vision|gpt-4-turbo|:vision/i;

const FAST = /:free|flash|mini|air|haiku|lite|fast|turbo|glm-4\.5-air|gemini-flash/i;
const REASON = /deepseek|reason|o1|o3|opus|sonnet|gpt-4|gpt-5|thinking|owl|claude/i;
const AGENT = /claude|gpt-4|gpt-5|gemini|deepseek|sonnet|opus|owl|qwen|mistral-large/i;
const CODE = /refactor|debug|implement|fix|test|architecture|multi-file|error|bug|function|class/i;

function scoreModel(modelId: string, ctx: AutoPickContext, listIndex: number): number {
  const id = modelId.toLowerCase();
  const msg = ctx.userMessage;
  const msgLen = msg.length;

  let score = Math.max(0, 3 - listIndex);

  if (ctx.hasVisionAttachments && VISION.test(id)) {
    score += 20;
  }
  if (ctx.hasVisionAttachments && FAST.test(id) && !VISION.test(id)) {
    score -= 12;
  }

  if (ctx.mode === 'ask') {
    if (FAST.test(id)) score += 14;
    if (REASON.test(id)) score += 5;
    if (msgLen < 300 && FAST.test(id)) score += 4;
    if (msgLen > 1500 && REASON.test(id)) score += 6;
  } else if (ctx.mode === 'plan') {
    if (REASON.test(id)) score += 16;
    if (FAST.test(id)) score += 5;
    if (/flash|mini|haiku/.test(id)) score -= 4;
  } else {
    if (AGENT.test(id)) score += 14;
    if (REASON.test(id)) score += 8;
    if (/flash|mini|haiku|lite/.test(id)) score -= msgLen > 400 ? 6 : 2;
    if (msgLen > 800 && AGENT.test(id)) score += 5;
  }

  if (CODE.test(msg.toLowerCase()) && (REASON.test(id) || AGENT.test(id))) {
    score += 7;
  }

  if ((ctx.conversationLength ?? 0) > 10 && REASON.test(id)) {
    score += 3;
  }

  return score;
}

/** Pick one model; when vision attachments are present, only vision-capable models are considered. */
export function pickAutoModelForRequest(
  availableModels: string[],
  ctx: AutoPickContext
): string | null {
  const models = availableModels.map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) {
    return null;
  }
  if (ctx.hasVisionAttachments) {
    const visionOnly = models.filter((m) => modelSupportsVision(m));
    if (visionOnly.length === 0) {
      return null;
    }
    return pickAutoModel(visionOnly, ctx) || null;
  }
  return pickAutoModel(models, ctx) || null;
}

/** Pick one model from the user's available list for this request. */
export function pickAutoModel(availableModels: string[], ctx: AutoPickContext): string {
  const models = availableModels.map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) {
    return '';
  }
  if (models.length === 1) {
    return models[0];
  }

  let best = models[0];
  let bestScore = -Infinity;
  for (let i = 0; i < models.length; i++) {
    const s = scoreModel(models[i], ctx, i);
    if (s > bestScore) {
      bestScore = s;
      best = models[i];
    }
  }
  return best;
}

export function formatAutoModelLabel(pickedId: string): string {
  const short =
    pickedId.length > 22 ? pickedId.slice(0, 20) + '…' : pickedId;
  return `Auto → ${short}`;
}
