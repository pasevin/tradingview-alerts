/**
 * Magic-link email via Resend. With no API key configured (local dev), the
 * link is logged to stdout instead of sent — so you can still sign in without
 * wiring up email.
 */
import { config } from "./config.js";

export async function sendMagicLink(email: string, link: string): Promise<void> {
  if (!config.mail.resendApiKey) {
    // eslint-disable-next-line no-console
    console.log(`[mail] (dev) magic link for ${email}: ${link}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.mail.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.mail.from,
      to: email,
      subject: "Your TradingView Alerts sign-in link",
      html: `<p>Click to finish signing in:</p><p><a href="${link}">${link}</a></p>`,
    }),
  });
  if (!res.ok) {
    throw new Error(`resend-failed: ${res.status} ${await res.text()}`);
  }
}
