// ✅ إعدادات Vercel: مهلة 60 ثانية + حجم body
export const config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '4mb'  // الحد الأقصى المسموح في Vercel Hobby
    }
  }
};

const ALLOWED_MODELS = [
  'claude-sonnet-5',
  'claude-opus-4.6',
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

// rate limiting بسيط (يعمل جزئيًا في Serverless — كافٍ للحماية من السخافة)
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
  // تنظيف دوري لتجنب تسرب الذاكرة
  if (rateMap.size > 500) {
    for (const [k, v] of rateMap) {
      if (now - v.start > 120000) rateMap.delete(k);
    }
  }
  return entry.count > 20;
}

export default async function handler(req, res) {
  // شبكة أمان: أي خطأ غير متوقع يرجع JSON وليس HTML
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
      .toString().split(',')[0].trim();

    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'عدد الطلبات كثير، انتظر دقيقة' });
    }

    // التحقق من متغيرات البيئة أولًا
    if (!process.env.SITE_PASSWORD) {
      console.error('MISSING: SITE_PASSWORD');
      return res.status(500).json({ error: 'SITE_PASSWORD غير مضبوط في Vercel' });
    }
    if (!process.env.CLEAN_API_KEY) {
      console.error('MISSING: CLEAN_API_KEY');
      return res.status(500).json({ error: 'CLEAN_API_KEY غير مضبوط في Vercel' });
    }

    const body = req.body || {};
    const { password, messages, model } = body;

    if (!password || password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: 'كلمة المرور خاطئة' });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'الرسائل فارغة' });
    }

    // تنظيف الرسائل واقتصاصها
    const cleanMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-24)
      .map(m => {
        if (typeof m.content === 'string') {
          return { role: m.role, content: m.content.slice(0, 15000) };
        }
        if (Array.isArray(m.content)) {
          const parts = m.content.map(p => {
            if (!p || typeof p !== 'object') return null;
            if (p.type === 'text') {
              return { type: 'text', text: String(p.text || '').slice(0, 15000) };
            }
            if (p.type === 'image_url' && p.image_url?.url) {
              return p;
            }
            return null;
          }).filter(Boolean).slice(0, 10);
          // إذا بقيت أجزاء، استخدمها؛ وإلا استخدم نص فارغ
          if (parts.length > 0) return { role: m.role, content: parts };
          return { role: m.role, content: '(مرفق غير صالح)' };
        }
        return { role: m.role, content: String(m.content || '').slice(0, 15000) };
      });

    // تحقق من الحجم الإجمالي
    const totalChars = JSON.stringify(cleanMessages).length;
    if (totalChars > 3_500_000) {
      return res.status(413).json({ error: 'المحادثة طويلة جدًا، امسح جزءًا منها' });
    }

    const chosenModel = ALLOWED_MODELS.includes(model) ? model : 'claude-sonnet-5';

    const fullMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...cleanMessages
    ];

    // مهلة داخلية 55 ثانية (أقل من maxDuration بقليل)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    let response;
    try {
      response = await fetch('https://cleanapis.com/v1/chat/completions', {
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
    } catch (fetchErr) {
      clearTimeout(timeout);
      console.error('Fetch error:', fetchErr.name, fetchErr.message);
      if (fetchErr.name === 'AbortError') {
        return res.status(504).json({ error: 'انتهت مهلة الطلب (55 ثانية). جرّب طلبًا أقصر أو نموذجًا أسرع.' });
      }
      return res.status(502).json({ error: 'فشل الاتصال بـ cleanapis: ' + fetchErr.message });
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('Provider error:', response.status, errText.slice(0, 500));
      return res.status(response.status).json({
        error: 'خطأ من المزود (' + response.status + '): ' + errText.slice(0, 200)
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr);
      return res.status(500).json({ error: 'رد المزود ليس JSON صالحًا' });
    }

    const text = data?.choices?.[0]?.message?.content;

    if (!text) {
      console.error('No text in response:', JSON.stringify(data).slice(0, 300));
      return res.status(500).json({ error: 'لم يصل رد من النموذج' });
    }

    return res.status(200).json({ text });

  } catch (globalErr) {
    // شبكة الأمان الأخيرة: أي خطأ غير متوقع يرجع JSON
    console.error('Global error:', globalErr);
    return res.status(500).json({
      error: 'خطأ داخلي: ' + (globalErr?.message || String(globalErr))
    });
  }
}
