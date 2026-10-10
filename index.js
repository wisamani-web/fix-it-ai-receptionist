import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY, RESEND_API_KEY } = process.env;

const WYSLY_BACKEND_MODEL = process.env.WYSLY_BACKEND_MODEL || 'gpt-5.6-luna';
const WYSLY_VOICE = process.env.WYSLY_VOICE || 'gleam';
const WYSLY_EMAIL_TO = (process.env.WYSLY_EMAIL_TO || 'techniciansfixit@gmail.com')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const WYSLY_EMAIL_FROM = process.env.WYSLY_EMAIL_FROM || 'onboarding@resend.dev';
const BACKEND_TIMEOUT_MS = Number(process.env.WYSLY_BACKEND_TIMEOUT_MS || 4500);

const WYSLY_TIMEZONE = process.env.WYSLY_TIMEZONE || 'America/New_York';
const WYSLY_BUSINESS_START = process.env.WYSLY_BUSINESS_START || '08:00';
const WYSLY_BUSINESS_END = process.env.WYSLY_BUSINESS_END || '18:00';

// Sallam's current daytime office number. Keep this configurable in Render.
const WYSLY_TRANSFER_NUMBER = process.env.WYSLY_TRANSFER_NUMBER || '+14407832103';
const WYSLY_TRANSFER_TIMEOUT_SECONDS = Number(
  process.env.WYSLY_TRANSFER_TIMEOUT_SECONDS || 15
);

// auto = normal Mon-Fri business hours; daytime / after_hours are useful for testing.
const WYSLY_FORCE_MODE = String(process.env.WYSLY_FORCE_MODE || 'auto').toLowerCase();

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY.');
  process.exit(1);
}

if (!RESEND_API_KEY) {
  console.warn('RESEND_API_KEY is missing. Calls will work, but email will not send.');
}

const fastify = Fastify();
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050;
const callSessions = new Map();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const GRASSHOPPER_BUSINESS_NUMBERS = new Set([
  '4405129091',
  '8885129091',
]);

function normalizePhoneDigits(phone) {
  if (!phone) return '';

  let digits = String(phone).replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }

  return digits;
}

function isGrasshopperBusinessCallerId(phone) {
  return GRASSHOPPER_BUSINESS_NUMBERS.has(normalizePhoneDigits(phone));
}

function getLastFour(phone) {
  if (!phone || phone === 'Unknown') return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function parseClockToMinutes(value, fallbackMinutes) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallbackMinutes;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return fallbackMinutes;
  }

  return hour * 60 + minute;
}

function getEasternBusinessClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WYSLY_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return {
    weekday: values.weekday,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function isRegularBusinessHours(date = new Date()) {
  if (WYSLY_FORCE_MODE === 'daytime') return true;
  if (WYSLY_FORCE_MODE === 'after_hours') return false;

  const { weekday, hour, minute } = getEasternBusinessClock(date);

  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) {
    return false;
  }

  const nowMinutes = hour * 60 + minute;
  const startMinutes = parseClockToMinutes(WYSLY_BUSINESS_START, 8 * 60);
  const endMinutes = parseClockToMinutes(WYSLY_BUSINESS_END, 18 * 60);

  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

function getCallMode(date = new Date()) {
  return isRegularBusinessHours(date) ? 'daytime' : 'after_hours';
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatCallerNumber(phone) {
  if (!phone || phone === 'Unknown') return null;

  let digits = String(phone).replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }

  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  return String(phone);
}

const APPROVED_SERVICE_AREAS = [
  'Westlake',
  'Avon',
  'Avon Lake',
  'Bay Village',
  'Rocky River',
  'North Olmsted',
  'North Ridgeville',
  'Elyria',
  'Sheffield Lake',
  'Sheffield Village',
  'Seven Hills',
  'Broadview Heights',
  'Medina',
  'Amherst',
  'Grafton',
  'Oberlin',
  'Fairview Park',
  'Lakewood',
  'Strongsville',
  'Berea',
  'Middleburg Heights',
  'Columbia Station',
  'Lorain',
];

const APPROVED_SERVICE_ZIPS = new Set([
  '44145', '44011', '44012', '44140', '44116', '44070', '44039',
  '44035', '44054', '44131', '44147', '44256', '44001', '44044',
  '44074', '44126', '44107', '44136', '44149', '44017', '44130',
  '44028', '44052', '44053', '44055', '44111', '44135', '44144',
]);

const AUTHORIZED_BRANDS = [
  'LG', 'Samsung', 'Electrolux', 'Frigidaire', 'GE', 'Sharp', 'Midea',
];

const SERVICED_BRANDS = [
  'Whirlpool', 'Maytag', 'Amana', 'KitchenAid', 'Haier',
  'Cafe', 'Café', 'Kenmore', 'Insignia',
];

const DO_NOT_SERVICE_BRANDS = [
  'Sub-Zero', 'Sub Zero', 'Wolf', 'Bosch', 'Viking',
];

function buildCallerIdLiveRule(callerNumber) {
  if (isGrasshopperBusinessCallerId(callerNumber)) {
    return `This call was forwarded through Grasshopper. The incoming caller ID is Fix It's own business number, not the customer's number. Never treat it as the customer's number. If a callback number is needed, ask: "What's the best phone number for our office to reach you?" If asked whether you have the caller's number, say: "I don't have your caller ID on this forwarded call. What's the best number for our office to reach you?"`;
  }

  const lastFour = getLastFour(callerNumber);
  const full = formatCallerNumber(callerNumber);

  if (lastFour && full) {
    return `Caller ID is ${full}. Normally confirm only the last four digits: "I have the number ending in ${lastFour}. Is that the best number for our office to reach you?" If the caller explicitly asks for the full number you see, you may read ${full}.`;
  }

  return `Caller ID is unavailable. When a callback number is needed, ask for it and repeat the full number once for accuracy.`;
}

function buildWyslyLiveInstructions(session, phase = 'initial') {
  const callerNumber = session?.callerNumber;
  const mode = session?.mode || 'after_hours';
  const priorTranscript =
    phase === 'resume_after_transfer'
      ? buildReadableTranscript(session).slice(-6000)
      : '';

  const modeInstructions =
    mode === 'daytime'
      ? `
DAYTIME ROLE
- You answer EVERY call first and protect the office from unnecessary calls.
- Resolve unsupported appliances, unsupported brands, simple price questions, service-area questions, spam, sales, and information-only calls yourself whenever possible.
- Do NOT transfer a caller merely because they ask for a human.
- A normal COD service caller should be transferred to Sallam only after the backend confirms they are QUALIFIED:
  1) supported appliance,
  2) serviced brand,
  3) approved service area,
  4) regular COD vs warranty is known,
  5) applicable diagnostic fee has been explained,
  6) customer accepts the diagnostic fee,
  7) customer genuinely wants service.
- Manufacturer/third-party warranty calls, existing Fix It service concerns, complaints/refund concerns, or another legitimate office-judgment matter may be transferred after basic identification/context is collected; normal COD fee acceptance is not required for those workflows.
- BEFORE telling a caller that you will transfer them, delegate to the backend and wait for the backend transfer decision.
- If the backend confirms TRANSFER_TO_SALLAM, say exactly: "Absolutely. I'll connect you with our office now." Then stop speaking and allow the application to transfer the call.
`
      : `
AFTER-HOURS ROLE
- Do not live-transfer calls.
- Resolve unsupported/informational calls yourself.
- For a valid service request, collect the complete intake needed for office follow-up.
- Never imply that a technician is being dispatched after hours.
- Tell qualified callers that the office will follow up for scheduling.
`;

  const resumeInstructions =
    phase === 'resume_after_transfer'
      ? `
RESUME AFTER UNSUCCESSFUL OFFICE TRANSFER
This is the SAME caller and SAME call. The office did not answer the live transfer.
Your first words now must be exactly:
"It looks like our office is assisting another customer right now. I can take the rest of your information and make sure they follow up with you."
Then continue the intake using everything already known. Do NOT ask the caller to repeat information already provided.

PRIOR SAME-CALL TRANSCRIPT:
${priorTranscript}
`
      : '';

  return `
You are Wysly, the receptionist for Fix It Appliance Service. Wysly is pronounced exactly like "wisely."

VOICE EXPERIENCE
- Sound warm, calm, confident, premium, natural, and concise.
- Use the Gleam voice naturally. Do not sound like a form or script.
- Usually speak 1 or 2 short sentences, then ask ONE question.
- Let the caller finish. If interrupted, stop immediately and listen.
- Do not overuse "thank you", "perfect", "great", or "got it".
- Never say "perfect" or "great" after a customer describes a problem.
- Stay in English unless the caller explicitly asks to switch.
- Do not diagnose, troubleshoot, tell the caller to reset something, or guess parts.
${modeInstructions}

OPENING
${
  phase === 'initial'
    ? `Your first spoken words must be:
"Thank you for calling Fix It Appliance Service. This is Wysly. How can I help you?"
Do not ask for the customer's name until you understand why they are calling.`
    : `Do not give the original greeting again. Follow the resume-after-transfer instruction above.`
}

BACKEND DELEGATION
You have a backend business controller. Use it whenever you need:
- any Fix It company fact or policy
- appliance or brand eligibility
- authorization status
- diagnostic fees or charges
- COD vs warranty workflow
- service-area decisions
- scheduling rules
- priority/routing decisions
- whether a daytime caller is qualified for live transfer
- the correct next intake question
- any answer you are not completely certain about

IMPORTANT
Never say:
- "let me check"
- "I'm checking"
- "one moment while I look"
- "let me look that up"
- "hold on while I check"
or anything similar.

When you delegate, do NOT announce that you are checking. A brief natural acknowledgment such as "Absolutely" or "I understand" is okay, then wait for the backend result.
If the backend cannot provide a verified answer, say you do not want to guess and offer office follow-up.

CRITICAL RELIABILITY
- Never invent a company policy, availability, mileage, warranty coverage, price, part availability, or appointment.
- Never claim you checked a live schedule, map, inventory, manufacturer system, claim system, or other system unless a verified backend result explicitly says it was checked.
- There is currently NO live scheduling access.
- Never promise same-day service.
- Remember everything the caller already said.
- Never ask the same question twice unless clarification is genuinely needed.
- If the caller corrects something, use the newest value and stop using the old one.
- Do not tell the customer a live transfer is happening until the backend explicitly confirms TRANSFER_TO_SALLAM.

DO NOT REPEAT PAYMENT OR LOCATION QUESTIONS
- Once the caller clearly establishes regular customer-paid service versus manufacturer/third-party warranty, keep that answer for the entire call. Do not ask who pays again unless the caller explicitly corrects it.
- "I'm paying", "out of pocket", and "not through a warranty company" establish customer-paid service. "Through LG warranty", "through Asurion", or another clearly identified warranty provider establishes warranty. A payment method alone is not proof of customer-paid service.
- A service city or ZIP already stated anywhere in this call stays known. If the caller says a city and later gives only a street address, keep the original city.
- An approved city OR an approved ZIP establishes service-area eligibility. Never require both just to decide whether Fix It services the location.
- Only ask for a missing ZIP once if needed to complete the address. If the caller does not know it, record it for office follow-up instead of asking again.
- If an answer was genuinely ambiguous, clarify once; if still unclear, note it for office review rather than repeating the same question.

NAME
For a real service request or office follow-up, ask:
"May I have your first and last name?"
If they give two name words, treat them as first and last name. Do not ask the first name again.
Do not add Mr., Mrs., Ms., Dr., Sir, or Ma'am unless clearly preferred.

PHONE
When the caller gives a 10-digit U.S. number, repeat it once in natural groups:
"I have 216-650-2666. Is that correct?"
If corrected, repeat only the corrected number once.

ADDRESS
Use city information already provided earlier in the call.
Confirm the complete service address once before finishing intake.
Never silently change a street number.

PHOTOS
For a real appliance service request, if model/serial is unavailable or difficult to read, say:
"If possible, please text us a clear picture of the model and serial tag to 440-512-9091."
If an error code is showing, add:
"And if there's an error code showing, a picture of that is helpful too."
Do not require photos.

CLOSING
Before ending a legitimate customer conversation ask:
"Is there anything else I can help you with?"
If no:
"Thanks for calling Fix It Appliance Service."
Never use time-of-day closings such as "good night" or "have a good morning."

${buildCallerIdLiveRule(callerNumber)}
${resumeInstructions}
`.trim();
}

function buildWyslyBackendInstructions(session) {
  const callerNumber = session?.callerNumber;
  const mode = session?.mode || 'after_hours';
  const callerRule = isGrasshopperBusinessCallerId(callerNumber)
    ? `Grasshopper replaced the original caller ID with Fix It's own number. Never use 440-512-9091 or 888-512-9091 as the customer's callback number unless the customer explicitly gives that number.`
    : `Caller ID, if present, may be used only after appropriate confirmation.`;

  return `
You are the private business-policy and workflow controller for Wysly, the live receptionist for Fix It Appliance Service.

CURRENT CALL MODE: ${mode === 'daytime' ? 'DAYTIME — LIVE OFFICE TRANSFER AVAILABLE' : 'AFTER HOURS — NO LIVE TRANSFER'}

VOICE CONVERSATION CONTEXT
The transcript may contain fragments, transcription errors, interruptions, or later corrections. Prefer the newest confirmed information. Do not invent missing details. Your job is to return concise, VERIFIED guidance to Wysly: answer the current customer question when possible, state the applicable company rule, and give the single best next question/action. Do not write long scripts.

BEFORE SUGGESTING ANY QUESTION, CHECK FACTS ALREADY SUPPLIED IN THE ENTIRE CALL:
- Who pays: if the caller already clearly said customer-paid versus manufacturer/third-party warranty, treat that gate as satisfied. Do not ask again or require another confirmation. A credit-card/cash preference alone does not establish who pays.
- Location: reuse a city or ZIP the caller already supplied, including before the latest street address. If an approved city OR ZIP is already known, the service-area gate is satisfied; never ask for both to check eligibility.
- A ZIP may be useful for a complete service address, but if missing ask at most once, then leave it for the office if unavailable. Never re-ask an already supplied city or ZIP.
- When information conflicts, use the caller's explicit latest correction. For genuinely unclear payment or location, ask a single clarification rather than repeatedly restarting the same intake questions.
- These are conversation-memory rules only. Do not alter actual diagnostic fees, warranty handling, service-area boundaries, or transfer requirements.

NEVER tell Wysly to say "let me check", "I'm checking", or similar. There is no live schedule, map, inventory, manufacturer portal, or claim lookup connected. If something cannot be verified from these rules, direct Wysly to say she does not want to guess and offer office follow-up.

DAYTIME GATEKEEPER / TRANSFER POLICY
During DAYTIME, Wysly answers every call first and should resolve/filter calls that do not need the office.

For a NORMAL COD call, return action TRANSFER_TO_SALLAM only when the transcript clearly establishes ALL of the following:
1. Supported residential appliance.
2. Brand is serviced by Fix It.
3. Service city/ZIP is approved.
4. Caller confirmed it is a regular customer-pay/COD request, not warranty.
5. Correct diagnostic fee was explained.
6. Caller explicitly accepted/understood the diagnostic fee and still wants service.
7. Caller wants to proceed with scheduling/service.

If any one of those items is missing, do NOT transfer yet. Give Wysly the next single question needed to complete qualification.

For manufacturer/third-party warranty:
- Do not require COD diagnostic-fee acceptance.
- Confirm it is a legitimate supported brand/appliance/location and collect enough basic context to identify the customer/request.
- During DAYTIME, a valid warranty/service-order call may transfer to Sallam.

For an existing Fix It service concern, possible Fix It warranty, complaint/refund concern, or a legitimate office-judgment issue:
- During DAYTIME, collect the caller's name and concise reason first.
- Then the call may transfer to Sallam.

Never transfer:
- TV/small appliance/unsupported equipment
- do-not-service brand
- commercial appliance
- obvious sales/marketing/spam/job-seeker/wrong-number call
- price-only caller who does not want service
- normal COD caller who has not accepted the applicable diagnostic fee
- normal COD caller outside/uncertain service area until office-review workflow is appropriate

During AFTER HOURS:
- Never return TRANSFER_TO_SALLAM.
- Resolve simple/unsupported calls or collect the full intake for office follow-up.

When action is TRANSFER_TO_SALLAM, Wysly's only spoken sentence should be:
"Absolutely. I'll connect you with our office now."

If a prior daytime transfer failed and the call resumed with Wysly:
- do not attempt another transfer in the same call
- collect the remaining intake
- tell the customer the office will follow up


COMPANY
- Fix It Appliance Service. Slogan: Fix It Better.
- Office: 799 Sharon Dr., Unit A, Westlake, OH 44145.
- Main call/text: 440-512-9091.
- Email: info@fixitapplianceservice.com.
- Office hours: Monday-Friday, 8:00 AM-6:00 PM.
- In-home residential appliance service only.
- No drop-offs. No direct public parts sales.
- No weekend, after-hours field service, or emergency service.
- Payments: credit card, check, cash.
- No cancellation fee.
- Technicians normally call 20-30 minutes before arrival.
- Technician requests are allowed but not guaranteed.
- Field technicians: Wisam, Mozzie, Brevan, Elijah. Sallam is office staff.

SUPPORTED APPLIANCES
Residential household:
washer, dryer, refrigerator, oven, double wall oven, cooktop, microwave, dishwasher.
If "range" or "stove", determine whether it is a freestanding/slide-in range, wall oven, built-in oven, or cooktop as applicable.
Do not service commercial appliances/equipment.

BRANDS
Authorized service provider:
LG, Samsung, Electrolux, Frigidaire, GE, Sharp, Midea.
Serviced but NOT authorized:
Whirlpool, Maytag, Amana, KitchenAid, Haier, Café/Cafe, Kenmore, Insignia.
Do NOT service:
Sub-Zero, Wolf, Bosch, Viking.
Unknown brand: do not guess; offer office confirmation.

COD DIAGNOSTIC FEES
- Washer: $99 + tax.
- Dryer: $99 + tax.
- Oven: $99 + tax.
- Refrigerator: $129 + tax.
- Microwave: $129 + tax.
- Double wall oven: $129 + tax.
- Dishwasher: $129 + tax.
- Cooktop: $129 + tax.
- COD diagnostic fee is waived if the customer approves/proceeds with the repair.
- Repairs use flat-rate pricing after diagnosis, not hourly pricing.
- Never quote or guess final repair cost before diagnosis.
- First appliance uses normal fee.
- Each additional appliance on the same visit: $49 + tax.
- Do not promise the $49 additional-appliance fee is waived.

MANDATORY COD VS WARRANTY GATE
Before quoting ANY COD diagnostic fee on a new service request, first determine:
"Is this a regular service request, or is it through the manufacturer or another warranty company?"
If manufacturer/third-party warranty: DO NOT quote normal COD diagnostic fee.
If recent Fix It repair/same issue: DO NOT automatically quote a new diagnostic fee.

MANUFACTURER / THIRD-PARTY WARRANTY
Recognize LG warranty, Samsung warranty, manufacturer warranty, SquareTrade, Asurion, service contract, claim number, service order, etc.
Collect when available:
- first and last name
- best callback number
- service address/city
- warranty/manufacturer company
- service order/claim number
- appliance
- brand
- brief issue
- model/serial
Do not promise warranty coverage or a free visit.
If service-order number is unavailable, note that it was not provided.
LG is an authorized Fix It brand. An LG warranty request is a valid OFFICE FOLLOW-UP workflow; there is nothing to "check" live.

FIX IT REPAIR WARRANTY
Completed Fix It repairs have 3 months parts and labor warranty.
For same/recent problem after a Fix It repair: possible warranty; office must review.
Do not promise free service and do not automatically quote another diagnostic fee.
Collect prior date and technician if known.

APPLIANCE-SPECIFIC QUESTIONS
Washer:
- ask front-load or top-load
- always determine whether washer/dryer are side-by-side or stacked
Stacked laundry:
- second technician required
- additional $125 + tax
- separate and not waived
Oven/stove/range:
- ask gas or electric
- identify configuration: freestanding/slide-in range, single wall oven, double wall oven, built-in oven, cooktop, or customer unsure
Model/serial:
- ask if available but never force the customer to search during the call
- encourage a clear tag photo by text to 440-512-9091
Error code:
- record it exactly
- ask for a photo if convenient
- do not diagnose from it

SERVICE AREAS — APPROVED YES
Westlake 44145
Avon 44011
Avon Lake 44012
Bay Village 44140
Rocky River 44116
North Olmsted 44070
North Ridgeville 44039
Elyria 44035
Sheffield Lake 44054
Sheffield Village 44035/44054
Seven Hills 44131
Broadview Heights 44147
Medina 44256
Amherst 44001
Grafton 44044
Oberlin 44074
Fairview Park 44126
Lakewood 44107
Strongsville 44136/44149
Berea 44017
Middleburg Heights 44130
Columbia Station 44028
Lorain 44052/44053/44055
West-side Cleveland ZIPs 44111, 44135, 44144

If a city/ZIP is approved, answer YES immediately.
For other locations, do not calculate mileage or pretend to use a map. Offer OFFICE FOLLOW-UP for service-area confirmation.

SCHEDULING
Wysly has NO live schedule access.
Appointments are Monday-Friday only, morning or afternoon.
If customer wants scheduling:
- collect intake
- ask preferred weekday if offered
- ask morning or afternoon preference
- do not promise date/window
- office confirms availability
Same-day request: note it, do not promise it.

PRIORITY
Refrigerator/freezer not cooling = HIGH PRIORITY for office review.
LG refrigerator not cooling = HIGH PRIORITY — LG REFRIGERATOR NOT COOLING.
Do not call it an emergency and do not promise same-day service.

CUSTOMER INTAKE
For a real service request / office follow-up:
- first and last name
- best callback number
- address/city (reuse city already stated; do not ask twice)
- appliance
- brand
- main issue
- error code if any
- model/serial if available
- appliance-specific details
- warranty/COD status before COD fee
- text permission
- preferred contact: call/text/no preference
- morning/afternoon preference if scheduling desired
Confirm phone once and complete address once. Do not reread every field at the end.

CALLER ID
${callerRule}

TEXT PERMISSION
Ask before office texts:
"Is it okay if our office texts you at that number about scheduling your service?"
If yes, ask preferred contact method call/text.
If no, phone only.
Do not send an automatic text in this current system.

SAFETY / EMERGENCIES
Fix It does not handle emergencies.
For gas smell, smoke/fire, sparking, burning smell, serious electrical danger, active/significant flooding, or immediate hazard:
- prioritize safety
- advise stopping use if safe
- direct to appropriate utility/fire department/electrician/plumber/emergency service
- no troubleshooting, panel removal, live-voltage testing, gas disconnection, or continued operation
- do not imply an after-hours technician is coming

COMPLAINTS / REFUNDS / UPSET CUSTOMERS
Stay calm, collect facts, route OFFICE FOLLOW-UP.
Never argue, assign blame, promise refund, promise free service, or remove charges.
Collect name, callback, address if relevant, appliance, what happened, approximate service date, technician if known, and what they want reviewed.

PRIVACY
Never ask for card number, bank information, SSN, password, PIN, security code, or login.
If caller begins giving sensitive payment/security information, stop them politely.

SPAM / SALES / JOB SEEKERS / WRONG NUMBERS
Do not create leads. Resolve politely as RESOLVED — NO ACTION.
Legitimate vendor operational messages may be OFFICE FOLLOW-UP.

ROUTING
RESOLVED — NO ACTION:
informational/unsupported/disqualified call, price-only caller who declines scheduling, spam, wrong number.
QUALIFIED LEAD — READY TO SCHEDULE:
supported normal COD repair, fee appropriately discussed, customer wants office scheduling follow-up.
HIGH PRIORITY:
refrigerator/freezer not cooling; especially LG.
OFFICE FOLLOW-UP:
warranty/manufacturer/service-order calls, possible recent Fix It warranty, Sallam callback request, unknown brand, uncertain service area, complaint/refund, other office judgment.

CONVERSATION QUALITY
- Ask one question at a time.
- Do not ask again for information already given.
- If customer gives several facts at once, remember all of them and skip those questions later.
- If caller corrects a fact, newest fact replaces old fact.
- Do not say "Mr./Mrs." unless clearly preferred.
- Do not diagnose.
- Do not say a part is in stock.
- Do not promise same-day repair.
- Do not invent holiday hours.
- Never use a time-of-day closing.
- Before ending: "Is there anything else I can help you with?" If no: "Thanks for calling Fix It Appliance Service."

RETURN FORMAT TO WYSLY
Return plain text only, concise enough for voice. Include:
1. VERIFIED answer/facts relevant to the customer's latest request.
2. The single best next question or action for Wysly.
3. Any important warning such as "do not quote COD fee" or "office follow-up".
Do not include private reasoning. Do not tell Wysly to say "let me check".
`.trim();
}

function getLatestCustomerText(session) {
  if (!session?.transcriptEvents?.length) return '';
  const events = [...session.transcriptEvents].sort(
    (a, b) => (a.startMs ?? 0) - (b.startMs ?? 0) || a.sequence - b.sequence
  );
  let i = events.length - 1;
  while (i >= 0 && events[i].speaker !== 'Customer') i--;
  if (i < 0) return '';
  const chunks = [];
  let nextStart = null;
  for (; i >= 0; i--) {
    const event = events[i];
    if (event.speaker !== 'Customer') break;
    if (nextStart !== null && nextStart - (event.endMs ?? event.startMs ?? 0) >= 1800) break;
    chunks.unshift(String(event.text || ''));
    nextStart = event.startMs ?? 0;
  }
  return chunks.join('').replace(/\s+/g, ' ').trim();
}

function recognizeApprovedLocationAnswer(text) {
  // Accept an explicit whole-utterance city/ZIP answer, never a substring.
  const reply = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/[.!?]+$/g, '').replace(/^actually,?\s+/, '');
  if (!reply || reply.length > 90) return null;
  const zip = reply.match(/^(?:(?:my|the)\s+)?zip(?:\s+code)?(?:\s+is)?\s+(\d{5})$/)
    || reply.match(/^(?:(?:it's|it is|in)\s+)?(\d{5})$/);
  if (zip && APPROVED_SERVICE_ZIPS.has(zip[1])) return { kind: 'zip', value: zip[1] };
  const spokenCity = reply
    .replace(/^(?:(?:i|we)\s+live\s+in|(?:i\s+am|i'm|we\s+are|we're)\s+in|(?:my|the)\s+city\s+is|city\s+is|(?:it\s+is|it's)(?:\s+in)?|in|from|located\s+in)\s+/, '')
    .replace(/,?\s+(?:oh|ohio)$/, '').trim();
  const city = APPROVED_SERVICE_AREAS.find(value => value.toLowerCase() === spokenCity);
  return city ? { kind: 'city', value: city } : null;
}

function getFastPolicyGuidance(session) {
  const latest = getLatestCustomerText(session);
  if (!latest) return null;

  const lower = latest.toLowerCase();

  // Deterministic warranty shortcut: prevents "let me check" hangs on common calls.
  if (/\b(lg|samsung|ge|frigidaire|electrolux|midea|sharp)\b/.test(lower) &&
      /\b(warranty|service order|claim)\b/.test(lower)) {
    return `This is a manufacturer/warranty workflow. Fix It is an authorized service provider for the named authorized brand. Do not quote the normal COD diagnostic fee. Collect first and last name, callback number, service address/city, warranty or manufacturer company, service order or claim number if available, appliance, issue, and model/serial if available. Route OFFICE FOLLOW-UP.`;
  }

  // Deterministic service-area shortcut.
  if (/\b(do you service|service|come to|go to)\b/.test(lower)) {
    for (const city of APPROVED_SERVICE_AREAS) {
      if (lower.includes(city.toLowerCase())) {
        return `Yes. Fix It Appliance Service services ${city}. Answer yes directly and continue naturally. Do not say you are checking.`;
      }
    }

    const zipMatch = latest.match(/\b\d{5}\b/);
    if (zipMatch && APPROVED_SERVICE_ZIPS.has(zipMatch[0])) {
      return `Yes. ZIP code ${zipMatch[0]} is an approved Fix It service area. Answer yes directly and continue naturally.`;
    }
  }

  // Deterministic brand shortcut.
  for (const brand of DO_NOT_SERVICE_BRANDS) {
    if (lower.includes(brand.toLowerCase())) {
      return `Fix It does not currently service ${brand}. Say so politely. Do not create a normal service request unless the caller also has another supported appliance/brand.`;
    }
  }

  for (const brand of AUTHORIZED_BRANDS) {
    if (lower.includes(brand.toLowerCase()) &&
        /\b(authorized|service provider|service|repair|work on)\b/.test(lower)) {
      return `Fix It Appliance Service services ${brand} and is an authorized service provider for ${brand}.`;
    }
  }

  for (const brand of SERVICED_BRANDS) {
    if (lower.includes(brand.toLowerCase()) &&
        /\b(service|repair|work on|authorized)\b/.test(lower)) {
      return `Fix It services ${brand}, but is not currently an authorized service provider for ${brand}.`;
    }
  }

  return null;
}

function controllerDecision({
  spokenGuidance,
  action = 'continue',
  routing = 'OFFICE FOLLOW-UP',
  qualified = false,
  reason = '',
}) {
  return {
    spoken_guidance: String(spokenGuidance || '').trim(),
    action,
    routing,
    qualified: Boolean(qualified),
    reason: String(reason || '').trim(),
  };
}

function getFastPolicyDecision(session) {
  const latest = getLatestCustomerText(session);
  if (!latest) return null;

  const lower = latest.toLowerCase();
  const mode = session?.mode || 'after_hours';

  // A caller answering the city/ZIP question should never require an AI lookup.
  const locationAnswer = recognizeApprovedLocationAnswer(latest);
  if (locationAnswer) {
    session.confirmedApprovedLocation = locationAnswer;
    const label = locationAnswer.kind === 'city'
      ? `${locationAnswer.value} is one of our approved service cities.`
      : `ZIP ${locationAnswer.value} is in our approved service area.`;
    return controllerDecision({
      spokenGuidance: `${label} Acknowledge this naturally and continue the service intake. Do not ask for the city or ZIP again merely to check coverage. Do not offer office confirmation for this approved location.`,
      action: 'continue',
      routing: 'OFFICE FOLLOW-UP',
      qualified: false,
      reason: 'Direct approved location answer; no remote policy lookup needed.',
    });
  }

  // No fake lookup for common manufacturer/warranty calls.
  if (
    /\b(lg|samsung|ge|frigidaire|electrolux|midea|sharp)\b/.test(lower) &&
    /\b(warranty|service order|claim)\b/.test(lower)
  ) {
    return controllerDecision({
      spokenGuidance:
        `This is a manufacturer/warranty workflow. Fix It is authorized for the named authorized brand. Do not quote the normal COD diagnostic fee. Ask for the customer's first and last name if not already known, then continue collecting the warranty/service-order basics. ${
          mode === 'daytime'
            ? 'Once the supported warranty request is identified and basic caller/context information is collected, it may be transferred to Sallam.'
            : 'After hours, collect the full intake for office follow-up.'
        }`,
      action: 'continue',
      routing: 'OFFICE FOLLOW-UP',
      qualified: false,
      reason: 'Recognized manufacturer/warranty workflow.',
    });
  }

  // Deterministic service-area answers.
  if (/\b(do you service|service|come to|go to|cover)\b/.test(lower)) {
    for (const city of APPROVED_SERVICE_AREAS) {
      if (lower.includes(city.toLowerCase())) {
        return controllerDecision({
          spokenGuidance: `Yes. Fix It Appliance Service services ${city}. Answer yes directly. Do not say you are checking.`,
          action: 'continue',
          routing: 'RESOLVED — NO ACTION',
          qualified: false,
          reason: 'Approved service city.',
        });
      }
    }

    const zipMatch = latest.match(/\b\d{5}\b/);
    if (zipMatch && APPROVED_SERVICE_ZIPS.has(zipMatch[0])) {
      return controllerDecision({
        spokenGuidance: `Yes. ZIP code ${zipMatch[0]} is an approved Fix It service area. Answer yes directly. Do not say you are checking.`,
        action: 'continue',
        routing: 'RESOLVED — NO ACTION',
        qualified: false,
        reason: 'Approved service ZIP.',
      });
    }
  }

  // Deterministic do-not-service brand answers.
  for (const brand of DO_NOT_SERVICE_BRANDS) {
    if (lower.includes(brand.toLowerCase())) {
      return controllerDecision({
        spokenGuidance: `Fix It does not currently service ${brand}. Say so politely. Do not transfer this call unless the caller also has another supported service request.`,
        action: 'continue',
        routing: 'RESOLVED — NO ACTION',
        qualified: false,
        reason: 'Do-not-service brand.',
      });
    }
  }

  return null;
}

async function runWyslyController(session) {
  const transcript = buildReadableTranscript(session);
  const fastDecision = getFastPolicyDecision(session);

  if (fastDecision) {
    return fastDecision;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      spoken_guidance: { type: 'string' },
      action: {
        type: 'string',
        enum: [
          'continue',
          'transfer_to_sallam',
          'resolve_no_action',
          'collect_full_intake',
        ],
      },
      routing: {
        type: 'string',
        enum: [
          'RESOLVED — NO ACTION',
          'QUALIFIED LEAD — READY TO SCHEDULE',
          'HIGH PRIORITY',
          'OFFICE FOLLOW-UP',
        ],
      },
      qualified: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: [
      'spoken_guidance',
      'action',
      'routing',
      'qualified',
      'reason',
    ],
  };

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: WYSLY_BACKEND_MODEL,
        store: false,
        instructions: buildWyslyBackendInstructions(session),
        input: `Current live call transcript:

${transcript}

Application state:
Call mode: ${session?.mode || 'after_hours'}
Previous live-transfer attempts: ${session?.transferAttempts || 0}
Previous transfer result: ${session?.transferResult || 'none'}

Return the verified controller decision for Wysly's NEXT response.
If the call is daytime and is truly ready for Sallam under the transfer policy, use action "transfer_to_sallam".
If the call already resumed after an unsuccessful transfer, never use transfer_to_sallam again.`,
        text: {
          format: {
            type: 'json_schema',
            name: 'wysly_controller_decision',
            strict: true,
            schema,
          },
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Wysly controller error:', response.status, data);
      return null;
    }

    const raw = String(data.output_text || '').trim();

    if (!raw) {
      console.error('Wysly controller returned no output_text.');
      return null;
    }

    const decision = JSON.parse(raw);

    // Hard application-level transfer guard.
    if (
      decision.action === 'transfer_to_sallam' &&
      (
        session?.mode !== 'daytime' ||
        (session?.transferAttempts || 0) > 0
      )
    ) {
      return controllerDecision({
        spokenGuidance:
          `Do not live-transfer this call. Continue collecting the intake and tell the customer the office will follow up.`,
        action: 'collect_full_intake',
        routing: decision.routing || 'OFFICE FOLLOW-UP',
        qualified: false,
        reason: 'Transfer blocked by application state.',
      });
    }

    return decision;
  } catch (error) {
    if (error?.name === 'AbortError') {
      console.error(`Wysly controller timed out after ${BACKEND_TIMEOUT_MS}ms.`);
    } else {
      console.error('Wysly controller request error:', error);
    }

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function safeCommentaryText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  // Commentary append is limited; keep a generous character cap below ~500 tokens.
  return value.slice(0, 1800);
}

function recordTranscript(session, speaker, text, startMs, endMs) {
  if (!session || !text) return;

  session.transcriptEvents.push({
    speaker,
    text,
    startMs: Number.isFinite(startMs) ? startMs : Date.now(),
    endMs: Number.isFinite(endMs) ? endMs : Date.now(),
    sequence: session.transcriptSequence++,
  });
  if (speaker === 'Customer') {
    // Save an explicitly recognized location for this call, not for other calls.
    const confirmed = recognizeApprovedLocationAnswer(getLatestCustomerText(session));
    if (confirmed) session.confirmedApprovedLocation = confirmed;
  }
}

function buildReadableTranscript(session) {
  if (!session?.transcriptEvents?.length) return 'No transcript was captured.';

  const events = [...session.transcriptEvents].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return a.sequence - b.sequence;
  });

  const grouped = [];

  for (const event of events) {
    const last = grouped[grouped.length - 1];

    if (
      last &&
      last.speaker === event.speaker &&
      event.startMs - last.endMs < 1800
    ) {
      last.text += event.text;
      last.endMs = Math.max(last.endMs, event.endMs);
    } else {
      grouped.push({ ...event });
    }
  }

  return grouped
    .map(item => `${item.speaker}: ${item.text.replace(/\s+/g, ' ').trim()}`)
    .filter(line => !line.endsWith(':'))
    .join('\n\n');
}

async function createOfficeSummary(session, transcript) {
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: WYSLY_BACKEND_MODEL,
        store: false,
        input: `Prepare a concise internal call summary for Fix It Appliance Service.

Use only facts actually stated in the transcript or caller ID, plus the fixed company policies below when classifying eligibility, fees, priority, or workflow.
Do not diagnose.
Do not invent customer details.
If something was not provided, write "Not provided."

Fixed company policies:
- Supported residential household major appliances: washer, dryer, refrigerator, oven, double wall oven, cooktop, microwave, dishwasher.
- No commercial appliances.
- Authorized brands: LG, Samsung, Electrolux, Frigidaire, GE, Sharp, Midea.
- Other serviced brands: Whirlpool, Maytag, Amana, KitchenAid, Haier, Café/Cafe, Kenmore, Insignia.
- Do-not-service brands: Sub-Zero, Wolf, Bosch, Viking.
- Unknown brands require office confirmation.
- COD diagnostic fee: $99 plus tax for washer, dryer, oven.
- COD diagnostic fee: $129 plus tax for refrigerator, microwave, double wall oven, dishwasher, cooktop.
- COD diagnostic fee is waived if the customer proceeds with the repair.
- Do not automatically apply COD diagnostic fees to manufacturer-warranty or warranty-company calls.
- Stacked washer/dryer: additional $125 plus tax for a second technician; separate and not waived.
- Each additional appliance on the same visit: $49 plus tax.
- Repairs use flat-rate pricing after diagnosis.
- Completed Fix It repairs include a 3-month parts and labor warranty.
- A recent Fix It repair concern may be under warranty; office must review. Do not promise free service or automatically quote a new diagnostic fee.
- Manufacturer/warranty-company calls should capture company name and service order number; do not promise coverage.
- Model/serial is helpful but not required; customer may text a tag photo to 440-512-9091.
- Appointments are Monday-Friday, morning or afternoon only. No weekends, after-hours service, or emergency service.
- Technicians typically call 20-30 minutes before arrival.
- Technician requests are allowed but not guaranteed.
- Recognized technicians: Wisam, Mozzie, Brevan, Elijah. Sallam is office staff.
- Payment methods: credit cards, checks, cash.
- No cancellation fee.
- Fix It does not sell parts directly to the public.
- Fix It provides in-home service only; no repair drop-offs at the office.
- Refrigerator/freezer not cooling is high priority; LG refrigerator not cooling is extra priority.
- Fix It does not handle emergencies.
- Approved service areas include Westlake, Avon, Avon Lake, Bay Village, Rocky River, North Olmsted, North Ridgeville, Elyria, Sheffield Lake, Sheffield Village, Seven Hills, Broadview Heights, Medina, Amherst, Grafton, Oberlin, Fairview Park, Lakewood, Strongsville, Berea, Middleburg Heights, Columbia Station, Lorain, and west-side Cleveland ZIPs 44111, 44135, and 44144. Other locations require office confirmation rather than guessing.
- Wysly has no live scheduling access and must never claim it checked real-time availability.
- Complaints, refund requests, charge disputes, and upset-customer service concerns require OFFICE FOLLOW-UP; Wysly must not promise refunds or free service.
- Wysly must never claim parts are in stock or promise same-day repair.
- Wysly must not collect sensitive financial or security information.
- Sales/marketing solicitations, job seekers, spam, and wrong numbers are not service leads and are normally RESOLVED — NO ACTION.
- If a customer refuses required scheduling information, do not pressure them; note only what is actually provided.
- Special access notes may include pets, gates, apartment/condo access, elevators, parking, mask requests, and other technician-entry details.
- Wysly must never invent holiday hours.
- Wysly is a receptionist and must not diagnose or provide troubleshooting/reset instructions.
- After-hours requests must not imply a technician is being dispatched after hours.
- During business hours, Wysly may filter calls and transfer qualified or legitimate office-judgment calls to Sallam.
- Routing outcomes:
  * RESOLVED — NO ACTION: informational, unsupported, disqualified, or price-only caller who does not want scheduling.
  * QUALIFIED LEAD — READY TO SCHEDULE: supported normal COD repair where customer wants office scheduling follow-up.
  * HIGH PRIORITY: real refrigerator/freezer not-cooling service request, especially LG not cooling.
  * OFFICE FOLLOW-UP: warranty/service-order call, possible Fix It repair warranty/recent service concern, Sallam callback request, unknown brand needing confirmation, or another case requiring office review.
- For a normal qualified scheduling lead, text permission should be explicitly captured as Yes or No.
- Do not infer text permission from the existence of caller ID. It must be stated by the customer.

Caller ID: ${
  isGrasshopperBusinessCallerId(session.callerNumber)
    ? 'Grasshopper forwarded call — original customer caller ID not available'
    : (session.callerNumber || 'Not available')
}
Call Mode: ${session.mode || 'after_hours'}
Transfer Attempts: ${session.transferAttempts || 0}
Transfer Result: ${session.transferResult || 'Not attempted'}

Transcript:
${transcript}

Return plain text with exactly these headings:
Routing Outcome:
Office Action:
Request Type:
Customer:
Caller ID:
Best Callback Number:
Customer Wants Scheduling:
Text Communication Allowed:
Preferred Contact Method:
Best Callback Time:
Service Address:
City:
Service Area Status:
Appliance:
Number of Appliances:
Appliance Eligibility:
Brand:
Brand Service Status:
Main Issue:
Error Code / Display Message:
Model / Serial:
Model/Serial Photo Requested:
Error Code Photo Requested:
Washer Type:
Laundry Configuration:
Cooking Fuel Type:
Cooking Appliance Type:
Applicable COD Diagnostic Fee:
Additional Appliance Fee:
Second Technician Charge:
Warranty / Manufacturer Company:
Service Order Number:
Possible Fix It Repair Warranty:
New or Existing Fix It Job:
Previous Fix It Technician Visit:
Requested Technician:
Preferred Appointment Window:
Access Notes:
Special Requests:
Complaint / Refund Concern:
Safety Concern:
Office Priority:
Office Notes:

For Routing Outcome choose exactly one:
RESOLVED — NO ACTION
QUALIFIED LEAD — READY TO SCHEDULE
HIGH PRIORITY
OFFICE FOLLOW-UP

Routing rules:
- Use RESOLVED — NO ACTION when Wysly answered the question completely, service is unsupported/disqualified, the caller only wanted information, or a normal COD caller declined scheduling.
- Use QUALIFIED LEAD — READY TO SCHEDULE only when a supported normal COD caller wants office contact to schedule.
- Use HIGH PRIORITY for a real refrigerator/freezer not-cooling service request that needs office scheduling/follow-up; LG refrigerator not cooling is the strongest priority.
- Use OFFICE FOLLOW-UP for manufacturer/warranty-company calls, possible Fix It repair warranty/recent service concerns, complaints/refund/charge disputes, Sallam callback requests, unknown brand confirmation requests, uncertain/borderline service-area requests, or other matters needing office judgment.
- Sales/marketing calls, job seekers, spam, wrong numbers, and simple informational calls that are fully resolved are RESOLVED — NO ACTION.
- A safety/emergency call that Fix It does not service and that requires no office follow-up is RESOLVED — NO ACTION unless the transcript clearly shows a separate later appliance-service request.

For Office Action write one concise action such as:
None
Contact customer to schedule
Priority scheduling follow-up
Review warranty/service order
Review possible Fix It warranty
Call customer
Confirm brand/service eligibility
Confirm service area
Review complaint / refund concern
Confirm holiday schedule
Answer customer question

For Customer: use the customer's first and last name when both were provided. Do not drop the last name.
For City: use the city stated anywhere in the conversation, even if the customer later provides only the street address. Do not mark City as missing when it was clearly established earlier.
For Service Address: use only the final confirmed street address. Do not change or normalize the street number from what the customer confirmed.
For Preferred Contact Method choose one: Call; Text; No preference; Not asked / not applicable; Unclear.
For Preferred Appointment Window choose one: Morning; Afternoon; No preference; Not asked / not applicable; Unclear.
For Customer Wants Scheduling choose one: Yes; No; Not asked / not applicable; Unclear.
For Text Communication Allowed choose one: Yes; No; Not asked / not applicable; Unclear.
Never mark text permission Yes unless the customer clearly agreed.

For Request Type choose one: Normal COD; Manufacturer warranty; Warranty company; Existing Fix It service concern; Complaint / refund concern; Unsupported service request; Information only; Sales / spam / wrong number; Needs clarification.
For Service Area Status choose one: Within normal area; Outside normal area; Office confirmation needed; Not applicable; Not provided.
For Appliance Eligibility choose one: Supported; Unsupported; Needs clarification.
For Brand Service Status choose one: Authorized service provider; Serviced, not authorized; Do not service; Needs office confirmation; Not provided.
For Caller ID: if the system says this was a Grasshopper forwarded call and the original customer caller ID was unavailable, write exactly: Grasshopper forwarded call — original customer caller ID not available.
For Best Callback Number: use the callback number the customer actually provided or confirmed during the conversation. Never use Fix It Appliance Service's own numbers 440-512-9091 or 888-512-9091 as the customer's callback number merely because they appeared as forwarded caller ID.
For Model/Serial Photo Requested choose one: Yes; No; Not applicable.
For Error Code Photo Requested choose one: Yes; No; Not applicable.
For Washer Type choose one: Front load; Top load; Customer not sure; Not applicable; Not provided.
For Cooking Fuel Type choose one: Gas; Electric; Customer not sure; Not applicable; Not provided.
For Cooking Appliance Type use the most specific type actually stated or confirmed, such as: Freestanding range / stove; Slide-in range; Single wall oven; Double wall oven / double oven; Built-in oven; Other built-in cooking appliance; Customer not sure; Not applicable; Not provided.
For Possible Fix It Repair Warranty choose one: Yes - office review needed; No indication; Needs clarification.
For Office Priority choose one factual category only: Standard; Refrigerator / freezer not cooling; HIGH PRIORITY — LG REFRIGERATOR NOT COOLING; Recent Fix It service concern; Active water leak; Safety concern; Unsupported service request.
For Complaint / Refund Concern choose one: Yes - office review needed; No indication; Needs clarification.
For Access Notes, include only practical technician-access details actually stated by the caller.
For Office Notes, include only concise operational details that would help the office. Never invent missing information.`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenAI summary error:', response.status, data);
      return 'Structured summary could not be generated.';
    }

    if (data.output_text) return data.output_text.trim();

    const text = data.output
      ?.flatMap(item => item.content || [])
      ?.filter(part => part.type === 'output_text')
      ?.map(part => part.text)
      ?.join('\n')
      ?.trim();

    return text || 'Structured summary could not be generated.';
  } catch (error) {
    console.error('Summary generation error:', error);
    return 'Structured summary could not be generated.';
  }
}

function getSummaryField(summary, fieldName) {
  if (!summary) return null;

  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = summary.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'mi'));
  return match ? match[1].trim() : null;
}

function buildEmailSubject(summary, callerNumber, session) {
  if (session?.transferResult === 'completed' || session?.officeAnswered) {
    return 'WYSLY — TRANSFERRED TO OFFICE';
  }

  const route = getSummaryField(summary, 'Routing Outcome');
  const priority = getSummaryField(summary, 'Office Priority');

  if (route === 'RESOLVED — NO ACTION') {
    return 'WYSLY — RESOLVED — NO ACTION';
  }

  if (route === 'QUALIFIED LEAD — READY TO SCHEDULE') {
    return 'WYSLY — QUALIFIED LEAD — READY TO SCHEDULE';
  }

  if (route === 'HIGH PRIORITY') {
    if (priority === 'HIGH PRIORITY — LG REFRIGERATOR NOT COOLING') {
      return 'WYSLY — HIGH PRIORITY — LG REFRIGERATOR NOT COOLING';
    }
    return 'WYSLY — HIGH PRIORITY — REFRIGERATOR / FREEZER';
  }

  if (route === 'OFFICE FOLLOW-UP') {
    return 'WYSLY — OFFICE FOLLOW-UP';
  }

  return `WYSLY — AFTER-HOURS CALL — ${callerNumber || 'Unknown Caller'}`;
}

async function sendAfterHoursEmail(session, summary, transcript) {
  if (!RESEND_API_KEY) {
    console.log('RESEND_API_KEY is missing.');
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `fixit-after-hours-${session.callSid}`,
      },
      body: JSON.stringify({
        from: `Wysly | Fix It Better <${WYSLY_EMAIL_FROM}>`,
        to: WYSLY_EMAIL_TO,
        subject: buildEmailSubject(summary, session.callerNumber, session),
        text: `FIX IT APPLIANCE SERVICE\nWYSLY CALL REVIEW\n\n========================================\nSERVICE REQUEST SUMMARY\n========================================\n\n${summary}\n\n========================================\nFULL CALL TRANSCRIPT\n========================================\n\n${transcript}\n\n========================================\n\nCall SID: ${session.callSid}\n\nAutomatically prepared by Wysly\nFix It Appliance Service\nAI Receptionist\n`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Resend email error:', response.status, data);
      return false;
    }

    console.log('After-hours email sent successfully.');
    console.log('Resend email ID:', data.id);
    return true;
  } catch (error) {
    console.error('Resend connection error:', error);
    return false;
  }
}

async function finishCall(callSid) {
  if (!callSid) return;

  const session = callSessions.get(callSid);
  if (!session) {
    console.log(`No session found for ${callSid}`);
    return;
  }

  if (session.emailSent || session.finishing) return;
  session.finishing = true;

  console.log(`Preparing Wysly call review for ${callSid}`);

  await delay(3000);

  const transcript = buildReadableTranscript(session);
  const summary = await createOfficeSummary(session, transcript);

  const routingOutcome = getSummaryField(summary, 'Routing Outcome') || 'Unknown';
  console.log(`Wysly routing outcome: ${routingOutcome}`);

  let sent = await sendAfterHoursEmail(session, summary, transcript);

  if (!sent) {
    console.log('First email attempt failed. Retrying once.');
    await delay(3000);
    sent = await sendAfterHoursEmail(session, summary, transcript);
  }

  if (sent) {
    session.emailSent = true;
    setTimeout(() => callSessions.delete(callSid), 60000);
  }

  session.finishing = false;
}

fastify.get('/', async (_request, reply) => {
  reply.send({
    message: 'Fix It Wysly Production receptionist is running!',
    voice: WYSLY_VOICE,
    backendModel: WYSLY_BACKEND_MODEL,
  });
});

fastify.get('/healthz', async (_request, reply) => {
  reply.send({
    ok: true,
    service: 'wysly-production',
    activeCalls: callSessions.size,
    callModeNow: getCallMode(),
    transferNumberConfigured: Boolean(WYSLY_TRANSFER_NUMBER),
    timestamp: new Date().toISOString(),
  });
});

function createNewCallSession(callSid, callerNumber) {
  const mode = getCallMode();

  const session = {
    callSid,
    callerNumber,
    mode,
    startedAt: Date.now(),
    transcriptEvents: [],
    transcriptSequence: 0,
    emailSent: false,
    finishing: false,
    pendingAction: null,
    transferInProgress: false,
    transferAttempts: 0,
    transferResult: null,
    officeAccepted: false,
    officeAnswered: false,
    resumeAfterTransfer: false,
    recoveryCount: 0,
  };

  callSessions.set(callSid, session);
  return session;
}

function buildWyslyStreamTwiML(host, session, phase = 'initial') {
  const callerNumber = xmlEscape(session.callerNumber || 'Unknown');
  const callSid = xmlEscape(session.callSid);
  const mode = xmlEscape(session.mode);
  const safePhase = xmlEscape(phase);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="https://${host}/after-wysly-stream" method="POST">
    <Stream url="wss://${host}/media-stream">
      <Parameter name="callerNumber" value="${callerNumber}" />
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="mode" value="${mode}" />
      <Parameter name="phase" value="${safePhase}" />
    </Stream>
  </Connect>
</Response>`;
}

fastify.all('/incoming-call', async (request, reply) => {
  const callerNumber = request.body?.From || request.query?.From || 'Unknown';
  const callSid = request.body?.CallSid || request.query?.CallSid || `unknown-${Date.now()}`;

  const session = createNewCallSession(callSid, callerNumber);

  console.log(`Incoming call ${callSid} from ${callerNumber}`);
  console.log(`Wysly call mode: ${session.mode}`);

  // Pre-warm GPT-Live immediately while Twilio is still opening the media stream.
  ensureLiveBridge(callSid, callerNumber, 'initial');

  const host = request.headers.host;
  reply.type('text/xml').send(buildWyslyStreamTwiML(host, session, 'initial'));
});

fastify.all('/after-wysly-stream', async (request, reply) => {
  const callSid = request.body?.CallSid || request.query?.CallSid;
  const session = callSessions.get(callSid);
  const host = request.headers.host;

  console.log('Twilio /after-wysly-stream callback:', callSid, session?.pendingAction);

  if (
    session &&
    session.mode === 'daytime' &&
    session.pendingAction === 'transfer_to_sallam'
  ) {
    session.pendingAction = null;
    session.transferInProgress = false;
    session.transferAttempts += 1;

    const number = xmlEscape(WYSLY_TRANSFER_NUMBER);

    session.officeAccepted = false;

    const parentSid = encodeURIComponent(session.callSid);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true" timeout="${WYSLY_TRANSFER_TIMEOUT_SECONDS}" action="https://${host}/transfer-result" method="POST">
    <Number url="https://${host}/office-screen?parentCallSid=${parentSid}" method="POST">${number}</Number>
  </Dial>
</Response>`;

    reply.type('text/xml').send(twiml);
    return;
  }

  // If the stream ended unexpectedly while the caller is still present,
  // do not trap the caller in a loop. Finish safely.
  if (callSid) finishCall(callSid);

  reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
});

fastify.all('/office-screen', async (request, reply) => {
  const parentCallSid =
    request.query?.parentCallSid ||
    request.body?.ParentCallSid ||
    request.query?.ParentCallSid;

  const host = request.headers.host;
  const encodedParent = encodeURIComponent(parentCallSid || '');

  // This is heard only by Sallam. The customer continues to hear ringing
  // because <Dial answerOnBridge="true"> is enabled.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="4" actionOnEmptyResult="true" action="https://${host}/office-screen-result?parentCallSid=${encodedParent}" method="POST">
    <Say>Qualified Fix It customer from Wysly. Press 1 to accept the call.</Say>
  </Gather>
  <Hangup/>
</Response>`;

  reply.type('text/xml').send(twiml);
});

fastify.all('/office-screen-result', async (request, reply) => {
  const parentCallSid =
    request.query?.parentCallSid ||
    request.body?.ParentCallSid ||
    request.query?.ParentCallSid;

  const digits =
    request.body?.Digits ||
    request.query?.Digits ||
    '';

  const session = callSessions.get(parentCallSid);

  if (digits === '1' && session) {
    session.officeAccepted = true;
    console.log(`Sallam accepted Wysly transfer for ${parentCallSid}.`);

    // Ending the screening TwiML normally allows Twilio to bridge the two legs.
    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting now.</Say>
</Response>`);
    return;
  }

  console.log(`Sallam did not accept Wysly transfer for ${parentCallSid}.`);

  reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
});

fastify.all('/transfer-result', async (request, reply) => {
  const callSid = request.body?.CallSid || request.query?.CallSid;
  const dialStatus =
    request.body?.DialCallStatus ||
    request.query?.DialCallStatus ||
    'unknown';

  const session = callSessions.get(callSid);
  const host = request.headers.host;

  console.log(`Transfer result for ${callSid}: ${dialStatus}`);

  if (!session) {
    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Hangup/></Response>`);
    return;
  }

  session.transferResult = dialStatus;

  if (
    session.officeAccepted &&
    (dialStatus === 'completed' || dialStatus === 'answered')
  ) {
    session.officeAnswered = true;
    finishCall(callSid);

    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Hangup/></Response>`);
    return;
  }

  // Sallam was busy / unavailable / did not answer.
  // Resume with Wysly on the SAME call and keep the earlier transcript.
  session.resumeAfterTransfer = true;
  session.pendingAction = null;
  session.transferInProgress = false;

  liveBridges.delete(callSid);
  ensureLiveBridge(callSid, session.callerNumber, 'resume_after_transfer');

  reply
    .type('text/xml')
    .send(buildWyslyStreamTwiML(host, session, 'resume_after_transfer'));
});

fastify.all('/call-ended', async (request, reply) => {
  const callSid = request.body?.CallSid || request.query?.CallSid;
  console.log('Twilio /call-ended callback:', callSid);

  if (callSid) finishCall(callSid);

  reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
});

const liveBridges = new Map();

function sendLiveEvent(bridge, payload) {
  if (bridge?.liveWs?.readyState === WebSocket.OPEN) {
    bridge.liveWs.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function sendAudioToTwilio(bridge, payload) {
  if (
    bridge?.twilioConnection?.readyState === WebSocket.OPEN &&
    bridge?.streamSid
  ) {
    bridge.twilioConnection.send(JSON.stringify({
      event: 'media',
      streamSid: bridge.streamSid,
      media: { payload },
    }));
    return;
  }

  if (bridge && bridge.pendingOutputAudio.length < 250) {
    bridge.pendingOutputAudio.push(payload);
  }
}

function shouldSuppressFinish(session) {
  return Boolean(
    session?.transferInProgress ||
    session?.pendingAction === 'transfer_to_sallam'
  );
}

function clearBridgeTimers(bridge) {
  if (!bridge) return;

  if (bridge.silenceGuardTimer) {
    clearTimeout(bridge.silenceGuardTimer);
    bridge.silenceGuardTimer = null;
  }

  if (bridge.transferTimer) {
    clearInterval(bridge.transferTimer);
    bridge.transferTimer = null;
  }
}

function scheduleDeadAirGuard(bridge) {
  if (!bridge) return;

  if (bridge.silenceGuardTimer) {
    clearTimeout(bridge.silenceGuardTimer);
  }

  const customerActivityAt = Date.now();

  bridge.silenceGuardTimer = setTimeout(() => {
    const session = callSessions.get(bridge.callSid);

    if (
      !session ||
      bridge.activeDelegations.size > 0 ||
      bridge.transferArmed ||
      bridge.liveWs?.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    const lastAssistant = bridge.lastAssistantAudioAt || 0;

    if (lastAssistant > customerActivityAt) {
      return;
    }

    console.warn(`Dead-air guard activated for ${bridge.callSid}.`);

    sendLiveEvent(bridge, {
      type: 'session.instructions.append',
      event_id: `dead_air_${Date.now()}`,
      delegation_id: null,
      content:
        `Respond now. Do not say you were checking or mention a delay. If the caller's latest request cannot be verified, say: "I don't want to give you the wrong information. I can take your details and have our office follow up." Then continue with one short question.`,
    });
  }, 5000);
}

function transitionToOfficeTransfer(bridge) {
  if (!bridge || bridge.transferExecuted) return;

  const session = callSessions.get(bridge.callSid);

  if (
    !session ||
    session.mode !== 'daytime' ||
    (session.transferAttempts || 0) > 0
  ) {
    return;
  }

  bridge.transferExecuted = true;
  session.pendingAction = 'transfer_to_sallam';
  session.transferInProgress = true;

  console.log(`Transitioning ${bridge.callSid} from Wysly to Sallam.`);

  clearBridgeTimers(bridge);

  // Close the Twilio media WebSocket. Twilio then continues the <Connect>
  // action and /after-wysly-stream performs the <Dial>.
  try {
    if (bridge.twilioConnection?.readyState === WebSocket.OPEN) {
      bridge.twilioConnection.close();
    }
  } catch (error) {
    console.error('Unable to close Twilio stream for transfer:', error);
  }

  try {
    if (bridge.liveWs?.readyState === WebSocket.OPEN) {
      bridge.liveWs.close();
    }
  } catch (error) {
    console.error('Unable to close GPT-Live stream for transfer:', error);
  }
}

function armTransferAfterWyslyPhrase(bridge) {
  if (!bridge || bridge.transferArmed) return;

  bridge.transferArmed = true;
  bridge.transferArmedAt = Date.now();
  bridge.transferAudioStarted = false;

  sendLiveEvent(bridge, {
    type: 'session.instructions.append',
    event_id: `transfer_phrase_${Date.now()}`,
    delegation_id: null,
    content:
      `Say exactly: "Absolutely. I'll connect you with our office now." Do not ask another question and do not add anything after that sentence.`,
  });

  bridge.transferTimer = setInterval(() => {
    const elapsed = Date.now() - bridge.transferArmedAt;
    const sinceAudio = Date.now() - (bridge.lastAssistantAudioAt || 0);

    if (
      bridge.transferAudioStarted &&
      elapsed >= 1300 &&
      sinceAudio >= 700
    ) {
      clearInterval(bridge.transferTimer);
      bridge.transferTimer = null;
      transitionToOfficeTransfer(bridge);
      return;
    }

    // Hard ceiling so the call can never hang while attempting transfer.
    if (elapsed >= 5000) {
      clearInterval(bridge.transferTimer);
      bridge.transferTimer = null;
      transitionToOfficeTransfer(bridge);
    }
  }, 150);
}

async function handleClientDelegation(bridge, delegationId) {
  if (!bridge || !delegationId || bridge.activeDelegations.has(delegationId)) {
    return;
  }

  bridge.activeDelegations.add(delegationId);
  const session = callSessions.get(bridge.callSid);

  try {
    const decision = await runWyslyController(session);

    if (!decision) {
      sendLiveEvent(bridge, {
        type: 'session.commentary.append',
        event_id: `backend_fallback_${Date.now()}`,
        delegation_id: delegationId,
        content:
          `Do not guess and do not say you are checking. Say: "I don't want to give you the wrong information. I can take your details and have our office follow up." Then ask the single next question needed for office follow-up.`,
      });
      return;
    }

    console.log(
      `Wysly controller decision for ${bridge.callSid}:`,
      decision.action,
      decision.routing,
      decision.reason
    );

    if (
      decision.action === 'transfer_to_sallam' &&
      session?.mode === 'daytime' &&
      (session?.transferAttempts || 0) === 0
    ) {
      session.lastControllerRouting = decision.routing;
      session.lastControllerReason = decision.reason;

      // Resolve the delegation quietly, then separately control the exact
      // transfer sentence so the transfer timing is deterministic.
      sendLiveEvent(bridge, {
        type: 'session.thinking.append',
        event_id: `backend_transfer_ok_${Date.now()}`,
        delegation_id: delegationId,
        content:
          `Verified: this call is qualified for live transfer to Sallam now. Do not ask another question.`,
      });

      armTransferAfterWyslyPhrase(bridge);
      return;
    }

    const content = safeCommentaryText(
      decision.spoken_guidance ||
      `Continue naturally with the single next question needed. Do not say you are checking.`
    );

    sendLiveEvent(bridge, {
      type: 'session.commentary.append',
      event_id: `backend_${Date.now()}`,
      delegation_id: delegationId,
      content,
    });
  } catch (error) {
    console.error('Client delegation handler error:', error);

    sendLiveEvent(bridge, {
      type: 'session.commentary.append',
      event_id: `backend_exception_${Date.now()}`,
      delegation_id: delegationId,
      content:
        `Do not guess and do not say you are checking. Say: "I don't want to give you the wrong information. I can take your details and have our office follow up."`,
    });
  } finally {
    bridge.activeDelegations.delete(delegationId);
  }
}

function closeLiveBridge(bridge, { finish = true } = {}) {
  if (!bridge || bridge.liveClosing) return;
  bridge.liveClosing = true;
  clearBridgeTimers(bridge);

  try {
    if (bridge.liveWs?.readyState === WebSocket.OPEN) {
      bridge.liveWs.close();
    }
  } catch (error) {
    console.error('Unable to close GPT-Live WebSocket:', error);
  }

  if (finish) {
    const session = callSessions.get(bridge.callSid);
    if (!shouldSuppressFinish(session)) {
      finishCall(bridge.callSid);
    }
  }
}

function createLiveBridge(callSid, callerNumber, phase = 'initial') {
  const existing = liveBridges.get(callSid);

  if (
    existing &&
    !existing.liveClosing &&
    existing.phase === phase
  ) {
    return existing;
  }

  if (existing) {
    clearBridgeTimers(existing);
    try {
      if (existing.liveWs?.readyState === WebSocket.OPEN) {
        existing.liveWs.close();
      }
    } catch {}
    liveBridges.delete(callSid);
  }

  const session = callSessions.get(callSid);

  const bridge = {
    callSid,
    callerNumber,
    phase,
    liveWs: null,
    liveStarted: false,
    liveClosing: false,
    twilioConnection: null,
    streamSid: null,
    pendingInputAudio: [],
    pendingOutputAudio: [],
    activeDelegations: new Set(),
    greetingRequested: false,
    firstAudioAt: null,
    lastAssistantAudioAt: null,
    createdAt: Date.now(),
    silenceGuardTimer: null,
    transferTimer: null,
    transferArmed: false,
    transferArmedAt: null,
    transferAudioStarted: false,
    transferExecuted: false,
  };

  liveBridges.set(callSid, bridge);

  const liveWs = new WebSocket('wss://api.openai.com/v1/live/sessions', {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  bridge.liveWs = liveWs;

  liveWs.on('open', () => {
    console.log(`Connected to GPT-Live for ${callSid} (${phase}).`);

    sendLiveEvent(bridge, {
      type: 'session.start',
      event_id: `start_${callSid}_${Date.now()}`,
      session: {
        model: 'gpt-live-1',
        instructions: buildWyslyLiveInstructions(session, phase),
        audio: {
          format: { type: 'audio/pcmu', rate: 8000 },
          output: { voice: WYSLY_VOICE },
        },
        delegation: { type: 'client' },
        store: false,
      },
    });
  });

  liveWs.on('message', message => {
    try {
      const event = JSON.parse(message.toString());

      if (event.type === 'session.started') {
        bridge.liveStarted = true;

        console.log(
          `GPT-Live session started for ${callSid} (${phase}) in ${
            Date.now() - bridge.createdAt
          }ms.`
        );

        if (!bridge.greetingRequested) {
          bridge.greetingRequested = true;

          const content =
            phase === 'resume_after_transfer'
              ? `Speak immediately now. Say exactly: "It looks like our office is assisting another customer right now. I can take the rest of your information and make sure they follow up with you." Then continue naturally from the prior call context and do not ask for information already provided.`
              : `Speak immediately now. Your exact first sentence is: "Thank you for calling Fix It Appliance Service. This is Wysly. How can I help you?" Then stop and listen. Do not add anything before it.`;

          sendLiveEvent(bridge, {
            type: 'session.instructions.append',
            event_id: `greeting_${callSid}_${Date.now()}`,
            delegation_id: null,
            content,
          });
        }

        // Audio that arrived before GPT-Live startup is commonly Grasshopper
        // transfer music/silence. Drop it so it cannot delay the greeting.
        bridge.pendingInputAudio.length = 0;
        return;
      }

      if (event.type === 'session.delegation.created') {
        const delegationId = event.delegation?.id;
        console.log(`GPT-Live delegated to backend: ${delegationId}`);
        handleClientDelegation(bridge, delegationId);
        return;
      }

      if (event.type === 'session.output_audio.delta' && event.delta) {
        const now = Date.now();

        if (!bridge.firstAudioAt) {
          bridge.firstAudioAt = now;
          console.log(
            `First Wysly audio for ${callSid}: ${
              bridge.firstAudioAt - bridge.createdAt
            }ms from bridge creation.`
          );
        }

        bridge.lastAssistantAudioAt = now;

        if (bridge.transferArmed) {
          bridge.transferAudioStarted = true;
        }

        sendAudioToTwilio(bridge, event.delta);
        return;
      }

      if (event.type === 'session.input_transcript.delta' && event.delta) {
        recordTranscript(
          callSessions.get(callSid),
          'Customer',
          event.delta,
          event.start_ms,
          event.end_ms
        );

        scheduleDeadAirGuard(bridge);
        return;
      }

      if (event.type === 'session.output_transcript.delta' && event.delta) {
        recordTranscript(
          callSessions.get(callSid),
          'Wysly',
          event.delta,
          event.start_ms,
          event.end_ms
        );
        return;
      }

      if (
        event.type === 'session.instructions.appended' ||
        event.type === 'session.commentary.appended' ||
        event.type === 'session.thinking.appended'
      ) {
        return;
      }

      if (event.type === 'error') {
        console.error('GPT-Live error:', JSON.stringify(event));

        if (
          bridge.liveStarted &&
          bridge.liveWs?.readyState === WebSocket.OPEN &&
          !bridge.transferArmed
        ) {
          sendLiveEvent(bridge, {
            type: 'session.instructions.append',
            event_id: `recover_${Date.now()}`,
            delegation_id: null,
            content:
              `Recover immediately. Do not mention a technical problem. Do not say you were checking. If you cannot verify the caller's latest request, say: "I don't want to give you the wrong information. I can take your details and have our office follow up." Then continue naturally.`,
          });
        }
        return;
      }

      if (event.type === 'session.closed') {
        console.log(`GPT-Live session closed for ${callSid} (${phase}).`);
        clearBridgeTimers(bridge);

        const currentSession = callSessions.get(callSid);

        if (!shouldSuppressFinish(currentSession)) {
          finishCall(callSid);
        }
      }
    } catch (error) {
      console.error('GPT-Live event processing error:', error);
    }
  });

  liveWs.on('error', error => {
    console.error('GPT-Live WebSocket error:', error);
  });

  liveWs.on('close', () => {
    console.log(`GPT-Live WebSocket disconnected for ${callSid} (${phase}).`);
    clearBridgeTimers(bridge);

    const currentSession = callSessions.get(callSid);

    if (!shouldSuppressFinish(currentSession)) {
      finishCall(callSid);
    }

    if (liveBridges.get(callSid) === bridge) {
      liveBridges.delete(callSid);
    }
  });

  return bridge;
}

function ensureLiveBridge(callSid, callerNumber, phase = 'initial') {
  const existing = liveBridges.get(callSid);

  if (
    existing &&
    !existing.liveClosing &&
    existing.phase === phase
  ) {
    return existing;
  }

  return createLiveBridge(callSid, callerNumber, phase);
}

fastify.get('/media-stream', { websocket: true }, (connection, _req) => {
  console.log('Twilio Media Stream connected.');

  let bridge = null;

  connection.on('message', message => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'connected':
          console.log('Twilio stream protocol connected.');
          break;

        case 'start': {
          const streamSid = data.start.streamSid;
          const callSid =
            data.start.customParameters?.callSid ||
            data.start.callSid ||
            null;
          const callerNumber =
            data.start.customParameters?.callerNumber ||
            null;
          const phase =
            data.start.customParameters?.phase ||
            'initial';

          console.log('Twilio stream started:', streamSid);
          console.log('CallSid:', callSid);
          console.log('Caller:', callerNumber);
          console.log('Phase:', phase);

          if (callSid && !callSessions.has(callSid)) {
            createNewCallSession(callSid, callerNumber);
          }

          bridge = ensureLiveBridge(callSid, callerNumber, phase);
          bridge.twilioConnection = connection;
          bridge.streamSid = streamSid;

          for (const audio of bridge.pendingOutputAudio.splice(0)) {
            sendAudioToTwilio(bridge, audio);
          }

          break;
        }

        case 'media':
          if (!bridge) return;

          if (
            bridge.liveStarted &&
            bridge.liveWs?.readyState === WebSocket.OPEN
          ) {
            sendLiveEvent(bridge, {
              type: 'session.input_audio.append',
              audio: data.media.payload,
            });
          } else if (bridge.pendingInputAudio.length < 50) {
            bridge.pendingInputAudio.push(data.media.payload);
          }
          break;

        case 'stop': {
          console.log('Twilio stream stopped.');

          if (bridge) {
            bridge.twilioConnection = null;
            bridge.streamSid = null;

            const session = callSessions.get(bridge.callSid);

            // During intentional daytime transfer, the parent call continues
            // into <Dial>. Do not finalize/email yet.
            if (shouldSuppressFinish(session)) {
              closeLiveBridge(bridge, { finish: false });
            } else {
              closeLiveBridge(bridge, { finish: true });
            }
          }
          break;
        }

        default:
          break;
      }
    } catch (error) {
      console.error('Twilio event error:', error);
    }
  });

  connection.on('close', () => {
    console.log('Twilio WebSocket disconnected.');

    if (bridge) {
      bridge.twilioConnection = null;
      bridge.streamSid = null;

      const session = callSessions.get(bridge.callSid);

      if (shouldSuppressFinish(session)) {
        closeLiveBridge(bridge, { finish: false });
      } else {
        closeLiveBridge(bridge, { finish: true });
      }
    }
  });

  connection.on('error', error => {
    console.error('Twilio WebSocket error:', error);
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, err => {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  console.log(`Fix It Wysly server listening on port ${PORT}`);
});
