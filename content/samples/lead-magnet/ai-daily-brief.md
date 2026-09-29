# AI Daily Brief to Your Telegram

Free chapter from Telegram as Your AI Control Center (Drop Shelf). Tested with n8n 2.x on 2026-09-29.

Every morning at 07:00 this workflow reads your calendar, your unread email and a news feed, asks Claude to turn it into a brief you can read in a minute, and sends it to you on Telegram. Setup takes about 20 minutes. The importable workflow is the JSON file that came with this chapter.

## What you need

- n8n 2.x, either n8n Cloud or self-hosted (Docker is fine).
- A Telegram bot of your own. Message @BotFather, send /newbot, and keep the token it gives you.
- Your Telegram chat id. Send any message to your new bot, then open https://api.telegram.org/bot<TOKEN>/getUpdates in a browser and copy message.chat.id.
- An Anthropic API key from console.anthropic.com.
- Google Calendar and Gmail accounts (optional: delete those nodes if you don't use them).

## Cost note

Running cost is the API call only. One brief is roughly 2,000 input tokens and 400 output tokens. With claude-opus-5-5 at $4 per million input tokens and $20 per million output tokens, that is about $0.02 per day, or around $0.60 a month. n8n Cloud's starter plan or a $5 VPS covers the hosting.

## Step 1: Import the workflow

1. In n8n, open Workflows, then Import from File, and pick ai-daily-brief.workflow.json.
2. You will see eight nodes in a row: Every morning 07:00, Today's calendar, Unread email (24h), Industry news (RSS), Build prompt, Claude: write the brief, Format for Telegram, Send to Telegram.

## Step 2: Connect the credentials

1. Today's calendar: create a Google Calendar OAuth2 credential and pick your calendar.
2. Unread email (24h): create a Gmail OAuth2 credential. The search filter skips promotions and social mail.
3. Claude: write the brief: create a Header Auth credential. Name: x-api-key. Value: your Anthropic API key.
4. Send to Telegram: create a Telegram credential with your bot token, then replace YOUR_TELEGRAM_CHAT_ID with your chat id.

## Step 3: Test it

1. Click Execute Workflow. Each node turns green as it runs.
2. Open Build prompt to check what the model will see. If a section is empty, the node before it has no data or no credential.
3. Your phone should buzz with the brief within about 20 seconds.

## How the Claude call works

The HTTP Request node posts to https://api.anthropic.com/v1/messages with the header anthropic-version: 2023-06-01. The body sets model to claude-opus-5-5, max_tokens to 4000 and output_config.effort to low, which is plenty for summarizing and keeps the call fast and cheap.

It also sends fallbacks: "default" with the header anthropic-beta: server-side-fallback-2026-07-01. If the model ever declines an input (a strange email, for example), the API retries on a fallback model in the same call instead of failing your morning run.

The response is a list of content blocks. Format for Telegram keeps only the text blocks, checks stop_reason for a refusal, and splits long briefs into Telegram-sized messages.

## Make it yours

- Change the time: edit triggerAtHour in the first node. The workflow timezone is in Workflow settings.
- Different news: swap the RSS URL, or duplicate the node for more feeds.
- Tone and length: edit the system text inside the Claude node. Ask for bullet points, another language, or a stricter word limit.
- Weekends off: in the trigger, switch to a weekdays-only cron such as 0 7 * * 1-5.

## Troubleshooting

- 401 from Claude: the Header Auth name must be exactly x-api-key.
- 400 from Claude: re-import the JSON rather than retyping the body; a stray quote breaks it.
- Telegram "chat not found": you must send your bot a message first, and the chat id is a number.
- Gmail returns nothing: good news, inbox zero. The workflow still runs because the nodes always output data.

## What's in the full book

Telegram as Your AI Control Center has 8 to 10 workflows built the same way, each tested and version-stamped, with a cost note: inbox triage with one-tap replies, content drafts you approve or reject from Telegram, invoice extraction to a spreadsheet, lead capture, and more. Updates arrive free through the bot when the tools change.
