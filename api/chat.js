export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password, messages, model } = req.body || {};

  if (!password || password !== process.env.SITE_PASSWORD) {
    return res.status(401).json({ error: 'كلمة المرور خاطئة' });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'الرسائل فارغة' });
  }

  const ALLOWED_MODELS = [
    'claude-sonnet-5',
    'gemini-3.7-flash',
    'gpt-5.5',
    'deepseek-v4-flash-0731',
    'seed-2.1-turbo',
    'claude-opus-4.6',
    'gpt-5.5-pro'
  ];
  const chosenModel = ALLOWED_MODELS.includes(model) ? model : 'claude-sonnet-5';

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

  // أضف system prompt في البداية
  const fullMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages
  ];

  try {
    const response = await fetch('https://cleanapis.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CLEAN_API_KEY}`
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: fullMessages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: 'خطأ من المزود: ' + errText.substring(0, 300)
      });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;

    if (!text) {
      return res.status(500).json({ error: 'لم يصل رد من النموذج' });
    }

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: 'خطأ في الاتصال: ' + err.message });
  }
}
