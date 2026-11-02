# Skillstack – Privacy Policy

**Version 0.1 · Effective date: [EFFECTIVE DATE]**
**Contact: [CONTACT EMAIL]**

> Draft for a free, invite-only beta. Not legal advice – have it reviewed before opening Skillstack to the public.

Skillstack ("we", "the app") helps you turn a learning goal into a study plan and run it day by day. This policy explains what we collect, why, who we share it with, and how you control it. We collect only what the app needs to work.

## 1. What we collect

**Account**
- Your email address, and your name if you give it.
- How you sign in (email code or Google), sign-up date, last activity, and the devices you're signed in on.
- Your acceptance of the Terms of Use and this policy (version and date).

**What you tell the app**
- Your answers in the guided intake: goals, target roles and skills, skill levels, background, education, tools you've used, time and budget preferences, and anything you write in free-text fields.
- Job postings you paste.
- Courses you add yourself.

**What you do in the app**
- Your plans, schedules, progress logs, hours, day reviews (difficulty, density, energy, notes), practice sessions and the feedback on them, and recommendations you accept or dismiss.

**Calendar (only if you connect it)**
- See section 5 (Google Calendar) for exactly what is read, stored and written.

**Technical data**
- Basic logs needed to run and secure the service (for example, request times and error messages). We don't log the content of your answers.
- Request-access forms: the email and short answers you submit.

We **don't** use advertising trackers, sell data, or build profiles for marketing.

## 2. Why we use it
- To create your account and keep you signed in.
- To build, schedule and adjust your study plan.
- To run practice sessions and save your feedback.
- To sync with your calendar, if you choose to.
- To keep the service secure, prevent abuse, and stay within the limits of the free services we use.
- To improve Skillstack using **aggregate** statistics (for example, how many people finish the intake) – not your individual content.

## 3. AI features
Some features use third-party AI models with free tiers: the day overview, plan suggestions, and in-app practice. When you use them:
- We send the model only what the feature needs – for example, your intake answers, the relevant courses, or your practice messages.
- **Contact details are removed first** (name, email, phone, address, links).
- Some free AI services may use the data they receive to improve their models (this applies to Google's Gemini free tier). Please **don't write personal or sensitive information** in free-text answers or practice chats.
- You can always use the app without the AI features: plans can be built by the rule-based builder, and practices can be run in your own Claude account instead.

## 4. Who we share data with
We use these service providers to run Skillstack. They process data on our behalf:

| Provider | What for |
|---|---|
| Supabase | Database, sign-in and authentication |
| Vercel | Hosting the app |
| Render | Hosting the backend |
| Cloudflare Turnstile | Bot protection on sign-in and request-access forms |
| Google | "Continue with Google" sign-in, and Calendar if you connect it |
| GitHub Models, Groq, Google Gemini | AI features (see section 3) |
| GitHub | Encrypted daily backups |

We don't sell or rent your data, and we don't share it with anyone else unless the law requires it.

## 5. Google Calendar (only if you connect it)

Connecting your calendar is optional and off by default. The app works fully without it. [Exact wording of this section needs check against Google's current API Services User Data Policy and the OAuth consent-screen requirements.]

**What we read.** With your permission (scope `calendar.readonly`), we read the **titles and times** of events from your Google calendars, plus the few fields needed to tell whether an event really blocks your time (for example, whether you accepted it and whether it is marked busy or free). We **never** read or keep event descriptions, attendees or locations.

**What we store.** While your calendar is connected, we store the titles and times of your **busy** events, so we can plan study blocks around them. We store a Google **refresh token**, encrypted, on our backend only; it is never sent to your browser. Nothing else from your calendar is stored.

**What we write.** With the scope `calendar.app.created`, we create, move and delete **only the events the app created itself**, in a separate secondary calendar that the app creates for you. We never change, move or delete any other event, in any calendar. The app checks this in code before every write.

**How to disconnect or revoke.**
- In the app: Settings → Calendar → Disconnect.
- In Google: open your Google Account permissions page ([Google Account third-party access page - link needs check]) and remove the app's access.

**Deletion.** When you disconnect your calendar, or delete your account, we delete the stored busy-event titles and times and the encrypted token, and we delete the events the app created in its own calendar. We do **not** delete anything else in your Google Calendar.

**Limited Use.** [Needs check against Google's current policy; use Google's exact required wording here.] The app's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements. In plain terms: we use Google Calendar data only to provide and improve the planning and calendar features you see in the app; we do not transfer it to others except as needed to provide those features, to comply with the law, or as part of a merger or sale with your notice; we do not use it for advertising; no human reads it except with your consent, for security, or to comply with the law; and **calendar data is never sent to AI models**.

## 6. Who at Skillstack can see your data
Skillstack is run by one person, who is the admin.
- The admin can see **account and usage information**: your email, sign-up and activity dates, your goal and target role, plan progress, certificates earned, and how much you use the AI features.
- The admin **can't** see your free-text answers, pasted job postings, practice conversations, or day-review notes – unless **you** turn on "Allow support access" in Settings (for example, when you ask for help). It switches off automatically after 7 days.
- Every time the admin opens your details, it's recorded, and you can see this log in Settings.

## 7. How long we keep it
- As long as your account exists.
- When you delete your account, your data is deleted immediately from the live database, and from backups within **30 days**.
- Access requests that are declined are deleted after [90] days.

## 8. Your rights and controls
- **See and download** everything we hold about you: Settings → Export my data.
- **Correct** your answers and plans at any time in the app.
- **Delete** your account and all its data: Settings → Delete my account.
- **Disconnect** your calendar at any time.
- **Ask** us anything about your data at [CONTACT EMAIL].

Depending on where you live (for example, under the Israeli Privacy Protection Law or the EU GDPR), you may have additional rights. Contact us to use them.

## 9. Security
Data is encrypted in transit and at rest by our providers. Each user's data is separated at the database level, so it can't be read by other users. Backups are encrypted. No system is perfectly secure; if a breach affects your data, we'll tell you as required by law.

## 10. Age
Skillstack is meant for people aged **[16]** and over.

## 11. Cookies and local storage
We use only what's needed to keep you signed in and remember your settings. No advertising or tracking cookies.

## 12. International transfers
Our providers may store data outside your country (for example, in the EU or the US). We use providers that apply standard safeguards for such transfers.

## 13. Changes
If we change this policy, we'll update the version and date above and show you a notice in the app.
