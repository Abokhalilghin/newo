export const config = {
  maxDuration: 60,
  api: { bodyParser: { sizeLimit: '4mb' } }
};

const ALLOWED_MODELS = [
  'claude-sonnet-5', 'claude-opus-4.6',
  'gemini-3.7-flash', 'gpt-5.5',
  'deepseek-v4-flash-0731', 'seed-2.1-turbo', 'gpt-5.5-pro'
];

const PERSONAS = {
  default: {
    prompt: 'أنت مساعد خبير وكاتب محترف. لا تجامل، اذهب مباشرة للجواب. عربية فصيحة بلا حشو.',
    temp: 0.7
  },
  content_creator: {
    prompt: 'أنت خبير صناعة محتوى فيروسي. قواعدك: 1- هوك أول 3 ثواني قاتل 2- زوايا غير مستهلكة 3- CTA يجبر على التعليق 4- تعطي 3 نسخ لكل فكرة + هاشتاغات + عنوان. لا كليشيهات، أمثلة بأرقام.',
    temp: 0.9
  },
  copywriter: {
    prompt: 'أنت كاتب إعلانات يبيع. تكتب بمعادلة AIDA/PAS. كل نص تعطيه بـ 3 أطوال: إعلان 15 كلمة، بوست 50 كلمة، سكريبت 30 ثانية. تركز على الفائدة لا الميزة.',
    temp: 0.8
  },
  teacher: {
    prompt: 'أنت معلم يشرح لأذكى طفل عمره 12 سنة. تبسط أي موضوع معقد بمثال ملموس + رسم ASCII + اختبار سريع من 3 أسئلة في النهاية.',
    temp: 0.5
  },
  coder: {
    prompt: 'أنت مهندس برمجيات Senior. تعطي كود جاهز للنسخ، تذكر الأخطاء الشائعة، وتقترح تحسين الأداء بالأرقام. لا تشرح نظريًا. استخدم تنسيق Markdown مع بلوكات كود.',
    temp: 0.3
  },
  trainer: {
    prompt: 'أنت مدرب انضباط وإنتاجية عسكري. لا تحفيز فارغ. تعطي جدول يومي بالدقائق، عقاب ومكافأة، وتتابع الالتزام. لهجتك حازمة ومباشرة.',
    temp: 0.4
  }
};

const rateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60000) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateMap.set(ip, entry);
  if (rateMap.size > 500) {
    for (const [k, v] of rateMap) if (now - v.start > 120000) rateMap.delete(k);
  }
  return entry.count > 30;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
      .toString().split(',')[0].trim();
    if (isRateLimited(ip)) return res.status(429).json({ error: 'طلبات كثيرة، انتظر دقيقة' });

    if (!process.env.SITE_PASSWORD) return res.status(500).json({ error: 'SITE_PASSWORD غير مضبوط' });
    if (!process.env.CLEAN_API_KEY) return res.status(500).json({ error: 'CLEAN_API_KEY غير مضبوط' });

    const body = req.body || {};
    const { password, messages, model, persona = 'default', customPrompt } = body;

    if (!password || password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: 'كلمة المرور خاطئة' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'الرسائل فارغة' });
    }

    const cleanMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-24)
      .map(m => {
        if (typeof m.content === 'string') return { role: m.role, content: m.content.slice(0, 15000) };
        if (Array.isArray(m.content)) {
          const parts = m.content.map(p => {
            if (!p || typeof p !== 'object') return null;
            if (p.type === 'text') return { type: 'text', text: String(p.text || '').slice(0, 15000) };
            if (p.type === 'image_url' && p.image_url?.url) return p;
            return null;
          }).filter(Boolean).slice(0, 10);
          return { role: m.role, content: parts.length ? parts : '(مرفق)' };
        }
        return { role: m.role, content: String(m.content || '').slice(0, 15000) };
      });

    if (JSON.stringify(cleanMessages).length > 3_500_000) {
      return res.status(413).json({ error: 'المحادثة طويلة جدًا، امسح جزءًا' });
    }

    const chosenModel = ALLOWED_MODELS.includes(model) ? model : 'claude-sonnet-5';

    let activePersona = PERSONAS[persona] || PERSONAS.default;
    if (persona === 'custom' && customPrompt && typeof customPrompt === 'string') {
      activePersona = { prompt: customPrompt.slice(0, 2000), temp: 0.7 };
    }

    const fullMessages = [
      { role: 'system', content: activePersona.prompt },
      ...cleanMessages
    ];

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 55000);

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
          temperature: activePersona.temp,
          max_tokens: 4096
        }),
        signal: ctrl.signal
      });
    } catch (fe) {
      clearTimeout(timeout);
      if (fe.name === 'AbortError') return res.status(504).json({ error: 'انتهت المهلة (55 ث)' });
      return res.status(502).json({ error: 'فشل الاتصال: ' + fe.message });
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('Provider error:', response.status, errText.slice(0, 500));
      return res.status(response.status).json({ error: 'خطأ من المزود (' + response.status + ')' });
    }

    const data = await response.json().catch(() => null);
    if (!data) return res.status(500).json({ error: 'رد المزود ليس JSON' });

    const text = data?.choices?.[0]?.message?.content;
    if (!text) return res.status(500).json({ error: 'لم يصل نص من النموذج' });

    return res.status(200).json({ text });

  } catch (e) {
    console.error('Global error:', e);
    return res.status(500).json({ error: 'خطأ داخلي: ' + (e?.message || String(e)) });
  }
}
