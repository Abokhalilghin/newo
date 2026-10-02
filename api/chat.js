```javascript
export const config = {
  api: { bodyParser: { sizeLimit: '6mb' } }
};

const ALLOWED_MODELS = [
  'claude-sonnet-5',
  'claude-opus-4.6',
  'claude-opus-5.5',
  'gemini-3.7-flash',
  'gpt-5.5',
  'deepseek-v4-flash-0731',
  'seed-2.1-turbo',
  'gpt-5.5-pro'
];

const SYSTEM_PROMPT =
  'أنت مساعد خبير وكاتب محترف. قواعد صارمة:\n' +
  '1. لا تجامل السائل ولا تمدح السؤال. اذهب مباشرة للجواب.\n' +
  '2. لا مقدمات إنشائية ولا عبارات مجاملة.\n' +
  '3. أعطِ أفضل حل ممكن، حتى لو كان صريحًا.\n' +
  '4. في الإبداع: زوايا غير مطروحة، وتجنّب الكليشيهات.\n' +
  '5. في المحتوى: أمثلة ملموسة، أرقام، وتفاصيل قابلة للتطبيق.\n' +
  '6. عربية فصيحة وسلسة، بلا حشو.\n' +
  '7. إذا أرسل المستخدم صورة، حلّلها بدقة وأجب عن سؤاله حولها.\n' +
  '8. إذا أرسل ملفًا نصيًا، اقرأه واعتمد عليه في ردك.';

const rateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60 * 1000) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;
  rateMap.set(ip, entry);
  return entry.count > 20;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0];
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'عدد الطلبات كثير، انتظر دقيقة' });
  }

  const { password, messages, model } = req.body || {};

  if (!process.env.SITE_PASSWORD || !process.env.CLEAN_API_KEY) {
    return res.status(500).json({ error: 'إعدادات الخادم ناقصة' });
  }

  if (!password || password !== process.env.SITE_PASSWORD) {
    return res.status(401).json({ error: 'كلمة المرور خاطئة' });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'الرسائل فارغة' });
  }

  let cleanMessages = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-24)
    .map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content.slice(0, 15000) };
      }
      if (Array.isArray(m.content)) {
        return {
          role: m.role,
          content: m.content.map(p => {
            if (p.type === 'text') return { type: 'text', text: String(p.text).slice(0, 15000) };
            if (p.type === 'image_url') return p;
            return p;
          }).slice(0, 10)
        };
      }
      return m;
    });

  const totalChars = JSON.stringify(cleanMessages).length;
  if (totalChars > 80000) {
    return res.status(413).json({ error: 'المحادثة طويلة جدًا، امسح جزء منها' });
  }

  const chosenModel = ALLOWED_MODELS.includes(model) ? model : 'claude-sonnet-5';

  const fullMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...cleanMessages
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch('https://cleanapis.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CLEAN_API_KEY}`
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: fullMessages,
        temperature: 0.7,
        max_tokens: 4096
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('Provider error:', response.status, errText.slice(0, 500));
      return res.status(502).json({ error: 'خطأ من المزود، حاول مرة أخرى' });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;

    if (!text) {
      return res.status(500).json({ error: 'لم يصل رد من النموذج' });
    }

    return res.status(200).json({ text });

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'انتهت مهلة الطلب' });
    }
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'خطأ في الاتصال' });
  }
}
```
