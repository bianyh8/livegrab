// Webhook 通知：事件开关 + 60 秒去重 + 失败重试（D18）
import { errText } from './util.js';

export class Notifier {
  constructor({ store, logger, fetchImpl = globalThis.fetch }) {
    this.store = store;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.lastSent = new Map(); // key → ts
    this.stats = { sent: 0, failed: 0, deduped: 0 };
  }

  get cfg() { return this.store.settings.notify || {}; }

  eventEnabled(event) {
    const c = this.cfg;
    switch (event) {
      case 'live': return c.onLive !== false;
      case 'start': return c.onStart !== false;
      case 'end': return c.onEnd !== false;
      case 'error': return c.onError !== false;
      case 'disk': return c.onDisk !== false;
      case 'cookie': return c.onCookie === true;
      default: return true;
    }
  }

  shouldDedupe(event, taskId) {
    // 去重总开关：前端「去重」关闭（notify.dedupe===false）时直接跳过去重
    if (this.cfg.dedupe === false) return false;
    const sec = Number(this.cfg.dedupeSec ?? 60);
    if (!sec) return false;
    const key = `${taskId || 'global'}:${event}`;
    const last = this.lastSent.get(key) || 0;
    if (Date.now() - last < sec * 1000) { this.stats.deduped++; return true; }
    this.lastSent.set(key, Date.now());
    return false;
  }

  async send(event, title, message, meta = {}) {
    const webhook = this.cfg.webhook;
    if (!webhook) { this.logger.debug(`通知跳过（${event}）：未配置 Webhook`); return { skipped: 'no-webhook' }; }
    if (!this.eventEnabled(event)) { this.logger.debug(`通知跳过（${event}）：事件开关已关闭`); return { skipped: 'disabled' }; }
    if (meta.test !== true && this.shouldDedupe(event, meta.taskId)) {
      this.logger.debug(`通知去重（${event} / ${meta.taskId || 'global'}）`);
      return { skipped: 'deduped' };
    }
    const text = meta.plain ? String(message) : `【LiveGrab】${title}\n${message}`;
    const url = String(webhook || '');
    const isFeishu = /open\.(feishu|larksuite)\.(cn|com)/i.test(url);
    const isDiscord = url.includes('discord.com/api/webhooks');
    let payload;
    if (isFeishu) payload = { msg_type: 'text', content: { text } };
    else if (isDiscord) payload = { content: text };
    else payload = {
      event, title, message, text,
      taskId: meta.taskId || null,
      taskName: meta.taskName || null,
      ts: new Date().toISOString(),
    };
    const retry = this.cfg.retry !== false;
    const delays = retry ? [0, 5000, 15000, 45000] : [0];
    let lastErr = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
      try {
        const res = await this.fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // 飞书等会返回 HTTP 200 但在 body 里带业务错误码，必须解析校验，否则会误判成功
        if (isFeishu || isDiscord) {
          const raw = await res.text().catch(() => '');
          let j = null; try { j = JSON.parse(raw); } catch { /* 非 JSON 忽略 */ }
          if (isFeishu && j && j.code !== undefined && Number(j.code) !== 0) {
            const extra = j.msg || j.error || (j.data && j.data.message) || raw || '未知错误';
            throw new Error(`飞书返回错误(${j.code})：${extra}`);
          }
        }
        this.stats.sent++;
        this.logger.info(`通知已发送（${event} → ${isFeishu ? '飞书' : isDiscord ? 'Discord' : 'Webhook'}）：${title}`);
        return { ok: true, attempts: i + 1, provider: isFeishu ? 'feishu' : isDiscord ? 'discord' : 'generic' };
      } catch (e) {
        lastErr = e;
        // errText 带上错误码（ECONNRESET/ETIMEDOUT 等）：Webhook 不通时能区分网络层与业务层失败
        this.logger.warn(`通知发送失败（第 ${i + 1}/${delays.length} 次）：${errText(e, { withStack: false })}`);
      }
    }
    this.stats.failed++;
    return { ok: false, error: lastErr?.message || 'unknown' };
  }

  async test() {
    const r = await this.send('test', '测试通知', '如果你收到这条消息，说明 Webhook 配置正确。', { test: true });
    return {
      success: !!r.ok,
      error: r.ok ? null : (r.error || '发送失败'),
      skipped: r.skipped || null,
      attempts: r.attempts || 0,
      provider: r.provider || null,
    };
  }
}
