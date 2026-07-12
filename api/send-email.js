export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { to, name, workout } = req.body;

    if (!to || !name || !workout) {
      return res.status(400).json({ error: "Missing required fields: to, name, workout" });
    }

    // Convert markdown tables to HTML
    function markdownToHtml(md) {
      let html = md;

      // Tables
      html = html.replace(/\|(.+)\|\r?\n\|[-\| :]+\|\r?\n((?:\|.+\|\r?\n?)*)/g, (_, header, rows) => {
        // `header` is captured without its outer pipes already, so no
        // slice needed here (unlike the row lines below, which still
        // carry their outer pipes and need slice(1,-1) to drop the
        // resulting empty leading/trailing strings).
        const ths = header.split('|').map(c =>
          `<th style="padding:8px 12px;background:#1a1100;color:#F5B800;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #333">${c.trim()}</th>`
        ).join('');
        const trs = rows.trim().split('\n').map((row, i) => {
          const tds = row.split('|').slice(1,-1).map(c =>
            `<td style="padding:8px 12px;border-bottom:1px solid #1a1a1a;color:#eeeeee;font-size:13px;vertical-align:top">${c.trim()}</td>`
          ).join('');
          const bg = i % 2 === 0 ? '#111111' : '#0f0f0f';
          return tds ? `<tr style="background:${bg}">${tds}</tr>` : '';
        }).filter(Boolean).join('');
        return `<table style="width:100%;border-collapse:collapse;margin:12px 0;border-radius:6px;overflow:hidden">\
<thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
      });

      // H1
      html = html.replace(/^# (.+)$/gm, '<h1 style="font-family:Arial,sans-serif;font-size:18px;font-weight:900;color:#ffffff;margin:24px 0 16px;letter-spacing:1px">$1</h1>');

      // H2
      html = html.replace(/^## (.+)$/gm, '<h2 style="font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#F5B800;background:#111;padding:10px 14px;border-left:3px solid #F5B800;margin:24px 0 12px;text-transform:uppercase;letter-spacing:1px">$1</h2>');

      // H3
      html = html.replace(/^### (.+)$/gm, '<h3 style="font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#FFD055;margin:16px 0 8px;text-transform:uppercase;letter-spacing:1px">$1</h3>');

      // Bold
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#ffffff">$1</strong>');

      // Numbered lists
      html = html.replace(/^(\d+)\. (.+)$/gm, '<div style="margin:12px 0;padding:12px 14px;background:#111111;border-radius:6px;border-left:2px solid #333"><span style="color:#F5B800;font-weight:700;font-size:13px">$1.</span> <span style="color:#eeeeee;font-size:13px;line-height:1.7">$2</span></div>');

      // Bullet points
      html = html.replace(/^[-*] (.+)$/gm, '<li style="color:#eeeeee;font-size:13px;margin:4px 0;line-height:1.6">$1</li>');
      html = html.replace(/(<li[^>]*>.*<\/li>)/gs, '<ul style="padding-left:20px;margin:8px 0">$1</ul>');

      // Line breaks
      html = html.replace(/\n\n/g, '<br>');
      html = html.replace(/\n/g, '');

      return html;
    }

    const workoutHtml = markdownToHtml(workout);

    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

        <!-- HEADER -->
        <tr><td style="background:#F5B800;padding:6px 0;text-align:center;font-size:1px">&nbsp;</td></tr>
        <tr>
          <td style="background:#111111;padding:32px 40px;text-align:center;border-bottom:1px solid #222">
            <p style="margin:0 0 4px;font-size:28px;font-weight:900;letter-spacing:4px;color:#F5B800">GETFITAF</p>
            <p style="margin:0;font-size:11px;color:#888;letter-spacing:2px;text-transform:uppercase">Your Personalised Workout Plan</p>
          </td>
        </tr>

        <!-- INTRO -->
        <tr>
          <td style="background:#0f0f0f;padding:32px 40px;border-bottom:1px solid #1a1a1a">
            <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#ffffff">Hey ${name}! 💪</p>
            <p style="margin:0;font-size:14px;color:#dddddd;line-height:1.7">
              Your personalised workout plan is ready. This programme has been built specifically for your goals, fitness level, and available equipment. Follow it consistently and results will come.
            </p>
          </td>
        </tr>

        <!-- WORKOUT CONTENT -->
        <tr>
          <td style="background:#0a0a0a;padding:32px 40px;color:#eeeeee;font-size:13px;line-height:1.8">
            ${workoutHtml}
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="background:#111111;padding:32px 40px;text-align:center;border-top:1px solid #222">
            <p style="margin:0 0 20px;font-size:14px;color:#dddddd;line-height:1.7">
              Want a fully customised programme with ongoing coaching, progression tracking, and expert guidance?
            </p>
            <a href="https://getfitaf.fitness" style="display:inline-block;background:#F5B800;color:#000000;text-decoration:none;padding:14px 36px;border-radius:4px;font-size:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase">Work With Satish →</a>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#0a0a0a;padding:24px 40px;text-align:center;border-top:1px solid #1a1a1a">
            <p style="margin:0;font-size:11px;color:#555;line-height:1.6">
              You received this because you built a workout on GetFitAF.<br>
              © 2026 GetFitAF · <a href="https://getfitaf.fitness" style="color:#F5B800;text-decoration:none">getfitaf.fitness</a>
            </p>
          </td>
        </tr>

        <!-- BOTTOM BAR -->
        <tr><td style="background:#F5B800;padding:6px 0;text-align:center;font-size:1px">&nbsp;</td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: "Satish @ GetFitAF <satish@getfitaf.fitness>",
        to: [to],
        subject: `${name}, your GetFitAF workout plan is here 💪`,
        html: emailHtml
      })
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error("Resend error:", errBody);
      return res.status(resendRes.status).json({ error: errBody });
    }

    const resendData = await resendRes.json();
    console.log("Email sent:", resendData.id);

    // Also log the lead
    console.log("LEAD:", JSON.stringify({ name, email: to, timestamp: new Date().toISOString() }));

    return res.status(200).json({ success: true, id: resendData.id });

  } catch (err) {
    console.error("Send email error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
