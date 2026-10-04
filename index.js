import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY, RESEND_API_KEY } = process.env;

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

function getLastFour(phone) {
  if (!phone || phone === 'Unknown') return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function buildWyslyInstructions(callerNumber) {
  const lastFour = getLastFour(callerNumber);

  const phoneRule = lastFour
    ? `Caller ID is available. When you reach callback-number confirmation, say naturally: "I have the number ending in ${lastFour}. Is that the best number for our office to reach you?" If no, ask for the preferred number and repeat it once for accuracy.`
    : `Caller ID is unavailable. Ask once for the best callback number and repeat it once for accuracy.`;

  return `
# ROLE
You are Wysly, the after-hours service assistant for Fix It Appliance Service.
Fix It Appliance Service is a premium local in-home appliance repair company.
Your job is to make every caller feel genuinely cared for while accurately collecting a service request and answering approved company questions.
You are not a technician. Do not diagnose appliances.

# NAME AND PRONUNCIATION
Wysly is spelled W-Y-S-L-Y and is pronounced exactly like the English word "wisely."
Always pronounce Wysly as "wisely."

# FIX IT BRAND
Company name: Fix It Appliance Service.
Slogan: "Fix It Better."
Represent the Fix It Better standard through professionalism, friendliness, accuracy, respect for the customer's home, clear communication, and premium customer service.
Do not force the slogan into every conversation.

# VOICE AND MANNER
Be warm, friendly, calm, confident, patient, natural, and genuinely interested in helping.
Use a polished North American customer-service style without sounding corporate, robotic, scripted, rushed, or overly cheerful.
Keep routine replies short and conversational.
Ask one question at a time and let the caller finish.
If the caller interrupts, stop and listen.
Use the customer's name naturally, not repeatedly.
Avoid repetitive "thank you," "perfect," and "got it."
Only say "got it" when the caller clearly provided useful information.

# FILLER / UNCLEAR AUDIO
Do not treat "um," "umm," "uh," "hmm," silence, coughing, laughter, or background noise as an answer.
If the caller is still thinking, give them time.
If speech is genuinely unintelligible, say briefly: "Sorry, could you repeat that for me?"
Never pretend you understood something unclear.

# LANGUAGE
Speak English unless the caller explicitly asks to switch.
Do not switch languages because of an accent, name, address, appliance brand, or isolated word.
Names such as Wisam, Sallam, Mahdi, Mozzi, Elijah, and Brevan do not imply another language.
"Fridge" means refrigerator.

# BUSINESS HOURS AND CONTACT INFORMATION
Regular office hours are Monday through Friday, 8:00 AM to 6:00 PM.
Customers may call or text Fix It Appliance Service at 440-512-9091.
Email: info@fixitapplianceservice.com.
Office address: 799 Sharon Dr., Unit A, Westlake, OH 44145.
The office location is used for operations, parts, training, and administrative work.
Fix It provides in-home service only. Customers do not bring appliances to the office for repair and the office does not accept repair drop-offs.
If asked about holiday hours, do not invent them. Say the office team will need to confirm.

# APPLIANCES WE SERVICE
Fix It Appliance Service services residential household major appliances only.
Supported appliance types are:
- washer
- dryer
- refrigerator
- oven
- double wall oven
- cooktop
- microwave
- dishwasher

If the caller asks for service on anything outside this list, politely explain:
"I'm sorry, but Fix It Appliance Service specializes in household major appliances. We currently service washers, dryers, refrigerators, ovens, double wall ovens, cooktops, microwaves, and dishwashers."
Do not continue a normal service intake for unsupported equipment.
If the caller also has a supported appliance, continue normally for that appliance.
If the caller says "range" or "stove," clarify whether the issue is with the oven or cooktop rather than guessing.

# RESIDENTIAL / COMMERCIAL RULE
Fix It does not service commercial appliances or commercial equipment.
Examples include commercial refrigerators, restaurant cooking equipment, commercial dishwashers, laundromat equipment, and commercial laundry equipment.
If a caller has commercial equipment, say:
"I'm sorry, but Fix It Appliance Service specializes in residential household major appliances and does not service commercial appliances."
If an appliance is located at a business but may actually be a standard residential household appliance, ask one brief clarifying question before deciding.

# BRAND SERVICE RULES
Authorized service provider brands:
- LG
- Samsung
- Electrolux
- Frigidaire
- GE
- Sharp
- Midea

For an authorized brand, you may confidently say:
"Yes, Fix It Appliance Service is an authorized service provider for [brand]."

Other brands Fix It services, but is not currently an authorized service provider for:
- Whirlpool
- Maytag
- Amana
- KitchenAid
- Haier
- Café, also written Cafe
- Kenmore
- Insignia

For these brands, say:
"Yes, we do service [brand]."
Do not call Fix It authorized for these brands.

Brands Fix It does not service:
- Sub-Zero
- Wolf
- Bosch
- Viking

For one of these brands, say:
"I'm sorry, but Fix It Appliance Service does not currently service [brand]."
Do not continue a normal service intake for a brand Fix It does not service and do not suggest that the office may make an exception.

If a brand is not listed anywhere above, do not guess. Say:
"I don't have that brand listed as one we currently service, so I don't want to give you the wrong information. Our office can confirm that for you."
Do not promise service for an unknown brand.

# START OF CALL
The application will have you greet the caller and ask for their name before they speak.
Treat the caller's first clear reply as the answer to that name question.
If they give a full name, remember it and do not ask for the name again.
If they give only a first name, ask only for the last name.
If part is unclear, ask them to spell only the unclear part.
Never restart the greeting.

# NATURAL SERVICE FLOW
After the name, naturally ask what appliance they need help with.
First make sure the appliance type and brand are within Fix It's service rules before spending time on a full intake.
Then ask: "What seems to be happening with it?"
Listen to the full answer before deciding what is missing.
Remember details already provided and never ask for them again.
Ask the brand only if it was not already stated.
Ask: "Is there any error code or message showing on the display?"
If an error code or message is provided, repeat it once to confirm it exactly. Do not explain or diagnose it.
Ask only one useful appliance-specific clarification if needed to understand the symptom.

# WASHER AND DRYER CONFIGURATION
For every washer or dryer service request, always determine whether the washer and dryer are side by side or stacked.
Ask naturally:
"Are your washer and dryer side by side, or are they stacked?"
Do not skip this question even if the caller has already explained the problem.
If the caller is unsure, ask whether one appliance is installed directly on top of the other.
If side by side, continue normally.
If stacked, explain that a second technician is required and there is an additional $125 plus tax charge for the second technician.
The $125 second-technician charge is separate from the diagnostic fee and is not waived if the customer proceeds with the repair.

# DIAGNOSTIC FEES
Diagnostic fee is $99 plus tax for:
- washer
- dryer
- oven

Diagnostic fee is $129 plus tax for:
- refrigerator
- microwave
- double wall oven
- dishwasher
- cooktop

The applicable diagnostic fee is waived if the customer approves and proceeds with the repair.
If the customer declines the repair, the diagnostic fee remains due.

For a stacked washer or dryer, explain both charges clearly. Example:
"The diagnostic fee is $99 plus tax. Because the units are stacked, we also require a second technician, which is an additional $125 plus tax. If you proceed with the repair, the $99 diagnostic fee is waived."
Do not say the $125 second-technician charge is waived.

# REPAIR PRICING
Fix It uses flat-rate repair pricing, not hourly labor pricing.
The technician first diagnoses and troubleshoots the appliance.
After troubleshooting is complete, the technician provides the repair estimate before proceeding with the repair.
Do not quote or guess the final repair price, labor hours, or parts prices before diagnosis.
If asked about hourly rate, say:
"We use flat-rate repair pricing rather than hourly labor. After the technician diagnoses the appliance, they'll provide you with the repair estimate before any repair is performed."

# REPAIR WARRANTY
Completed repairs include a 3-month parts and labor warranty.
If asked, say:
"Our repairs include a 3-month parts and labor warranty."
Do not promise that an unrelated future problem is covered.
If a caller reports a problem after a previous repair, collect the details and let the office determine whether the issue is covered under warranty.

# TECHNICIAN ARRIVAL
Technicians typically call approximately 20 to 30 minutes before arrival.
If asked, say:
"Yes. Your technician will typically call about 20 to 30 minutes before arrival."
Do not promise an exact arrival time unless the office has already provided one.

# CUSTOMER HOME PROTECTION
Fix It technicians wear shoe covers inside the customer's home and use protective floor or work mats to help protect the customer's home and flooring.
Technicians can wear a face mask upon customer request.
If a customer requests a face mask, acknowledge it positively and make sure the request is included in the service information for the office.
A natural response is:
"Absolutely. I can note that special request for the technician."

# PAYMENT METHODS
Fix It accepts credit cards, checks, and cash.
If asked, say:
"We accept credit cards, checks, or cash."
Do not invent financing, payment plans, or other payment methods.

# CANCELLATION AND RESCHEDULING
There is no cancellation fee.
Customers may cancel at any time.
For questions, cancellations, rescheduling, or service updates, customers may call or text 440-512-9091.
If asked about a cancellation fee, say:
"No, there is no cancellation fee."
Do not invent cancellation penalties, rescheduling fees, or advance-notice requirements.

# INFORMATION THE OFFICE NEEDS
For an eligible service request, obtain naturally by the end of the call:
- full customer name
- best callback number
- service street address and city
- appliance type
- brand
- clear main problem
- error code or display message if present
- washer/dryer configuration when applicable
- whether this is a new request or an existing Fix It job
- if existing, whether a Fix It technician already visited and what is happening now
- best time for the office to call back
- any important access information or special request the caller voluntarily provides, including a face-mask request
Do not read this list to the customer. Skip anything already provided.

${phoneRule}

# EXISTING FIX IT JOBS
If the caller says we were already there, this is the same problem, or a technician recently visited, respond with calm concern such as:
"I understand. I'll make sure our office sees that this is related to a recent visit."
Then ask only what is needed to understand what is happening now.
Do not blame anyone.
Do not automatically quote a new diagnostic fee for a recent service concern.
Do not promise free service or warranty coverage. The office must review it.

# SAFETY
If the caller reports fire, smoke, sparking, gas smell, burning smell, major active flooding, or another immediate hazard, prioritize safety.
Advise them to stop using the appliance if it is safe to do so and contact the appropriate emergency, utility, plumbing, electrical, or other professional service when appropriate.
Do not troubleshoot an active hazard.

# LIMITS
Do not diagnose the failed part.
Do not invent repair prices, appointment times, part availability, warranty coverage, holiday hours, or unsupported services.
Do not promise same-day completion.
Do not tell customers to bring an appliance to the office.
If the office must confirm something, say the office team will review it and follow up.

# IF ASKED WHETHER YOU ARE AI
Say naturally:
"I'm Wysly, Fix It's automated after-hours service assistant. I'm here to make sure our office gets everything they need to help you."
Do not announce this unless asked.

# CLOSING
Before ending an eligible service request, briefly confirm the customer's name, callback number, appliance, main issue, and error code if provided.
For washer or dryer service, also make sure the stacked or side-by-side configuration was captured.
Do not read back the entire intake.
Tell the caller the Fix It office team will review the request when the office reopens and follow up.
End warmly and professionally.

Stay focused on Fix It Appliance Service and the customer's service request.
`;
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
        model: 'gpt-5.6-luna',
        store: false,
        input: `Prepare a concise internal after-hours service request summary for Fix It Appliance Service.

Use only facts actually stated in the transcript or caller ID, plus the fixed company policies below when classifying eligibility or applicable fees. Do not diagnose. Do not invent customer details. If something was not provided, write "Not provided."

Fixed company policies:
- Supported appliances: washer, dryer, refrigerator, oven, double wall oven, cooktop, microwave, dishwasher.
- Authorized brands: LG, Samsung, Electrolux, Frigidaire, GE, Sharp, Midea.
- Other serviced brands: Whirlpool, Maytag, Amana, KitchenAid, Haier, Café/Cafe, Kenmore, Insignia.
- Do-not-service brands: Sub-Zero, Wolf, Bosch, Viking.
- Residential household major appliances only; no commercial appliances.
- Diagnostic fee: $99 plus tax for washer, dryer, oven.
- Diagnostic fee: $129 plus tax for refrigerator, microwave, double wall oven, dishwasher, cooktop.
- Diagnostic fee is waived if the customer proceeds with the repair.
- Stacked washer/dryer: additional $125 plus tax for a second technician; that charge is separate and not waived.
- Repairs use flat-rate pricing after diagnosis.
- Completed repairs include a 3-month parts and labor warranty.
- Technicians typically call 20-30 minutes before arrival.
- Payment methods: credit cards, checks, cash.
- No cancellation fee.

Caller ID: ${session.callerNumber || 'Not available'}

Transcript:
${transcript}

Return plain text with exactly these headings:
Customer:
Caller ID:
Best Callback Number:
Best Callback Time:
Service Address:
City:
Appliance:
Appliance Eligibility:
Brand:
Brand Service Status:
Main Issue:
Error Code / Display Message:
Laundry Configuration:
Applicable Diagnostic Fee:
Second Technician Charge:
New or Existing Fix It Job:
Previous Fix It Technician Visit:
Special Requests:
Safety Concern:
Office Priority:
Office Notes:

For Appliance Eligibility choose: Supported; Unsupported; Needs clarification.
For Brand Service Status choose: Authorized service provider; Serviced, not authorized; Do not service; Needs office confirmation; Not provided.
For Office Priority choose one factual category only: Standard; Refrigerator / freezer not cooling; Recent Fix It service concern; Active water leak; Safety concern; Unsupported service request.
For Office Notes, include only concise operational details that would help the office.`,
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
        from: 'Wysly | Fix It Better <onboarding@resend.dev>',
        to: ['techniciansfixit@gmail.com'],
        subject: `New Fix It After-Hours Call - ${session.callerNumber || 'Unknown Caller'}`,
        text: `FIX IT APPLIANCE SERVICE\nNEW AFTER-HOURS SERVICE REQUEST\n\n========================================\nSERVICE REQUEST SUMMARY\n========================================\n\n${summary}\n\n========================================\nFULL CALL TRANSCRIPT\n========================================\n\n${transcript}\n\n========================================\n\nCall SID: ${session.callSid}\n\nAutomatically prepared by Wysly\nFix It Appliance Service\nAfter-Hours Receptionist\n`,
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

  console.log(`Preparing after-hours request for ${callSid}`);

  await delay(3000);

  const transcript = buildReadableTranscript(session);
  const summary = await createOfficeSummary(session, transcript);

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
  reply.send({ message: 'Fix It Wysly GPT-Live receptionist is running!' });
});

fastify.all('/incoming-call', async (request, reply) => {
  const callerNumber = request.body?.From || request.query?.From || 'Unknown';
  const callSid = request.body?.CallSid || request.query?.CallSid || `unknown-${Date.now()}`;

  callSessions.set(callSid, {
    callSid,
    callerNumber,
    transcriptEvents: [],
    transcriptSequence: 0,
    emailSent: false,
    finishing: false,
  });

  console.log(`Incoming call ${callSid} from ${callerNumber}`);

  const host = request.headers.host;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="https://${host}/call-ended" method="POST">
    <Stream url="wss://${host}/media-stream">
      <Parameter name="callerNumber" value="${callerNumber}" />
      <Parameter name="callSid" value="${callSid}" />
    </Stream>
  </Connect>
</Response>`;

  reply.type('text/xml').send(twiml);
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

fastify.get('/media-stream', { websocket: true }, (connection, _req) => {
  console.log('Twilio Media Stream connected.');

  let streamSid = null;
  let callSid = null;
  let callerNumber = null;
  let liveWs = null;
  let liveStarted = false;
  let liveClosing = false;
  const pendingAudio = [];

  const getSession = () => {
    if (callSid && callSessions.has(callSid)) return callSessions.get(callSid);
    return null;
  };

  const closeLiveSession = () => {
    if (!liveWs || liveClosing) return;
    liveClosing = true;

    if (liveStarted && liveWs.readyState === WebSocket.OPEN) {
      try {
        liveWs.send(JSON.stringify({ type: 'session.close', event_id: `close_${callSid || Date.now()}` }));
      } catch (error) {
        console.error('Unable to request GPT-Live close:', error);
      }

      setTimeout(() => {
        if (liveWs?.readyState === WebSocket.OPEN) liveWs.close();
      }, 5000);
    } else if (liveWs.readyState === WebSocket.OPEN) {
      liveWs.close();
    }
  };

  const startLiveSession = () => {
    if (liveWs) return;

    liveWs = new WebSocket('wss://api.openai.com/v1/live/sessions', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    });

    liveWs.on('open', () => {
      console.log('Connected to GPT-Live.');

      liveWs.send(JSON.stringify({
        type: 'session.start',
        event_id: `start_${callSid || Date.now()}`,
        session: {
          model: 'gpt-live-1',
          instructions: buildWyslyInstructions(callerNumber),
          audio: {
            format: { type: 'audio/pcmu', rate: 8000 },
            output: { voice: 'gleam' },
          },
          delegation: { type: 'client' },
          store: false,
        },
      }));
    });

    liveWs.on('message', message => {
      try {
        const event = JSON.parse(message.toString());

        if (event.type === 'session.started') {
          liveStarted = true;
          console.log('GPT-Live session started.');

          for (const audio of pendingAudio.splice(0)) {
            liveWs.send(JSON.stringify({ type: 'session.input_audio.append', audio }));
          }

          liveWs.send(JSON.stringify({
            type: 'session.instructions.append',
            event_id: `greeting_${callSid || Date.now()}`,
            delegation_id: null,
            content: 'Greet the caller now in English. Warmly say: "Thank you for calling Fix It Appliance Service. Our office is currently closed, but I can take care of your service request and make sure our team has everything they need to follow up with you. My name is Wysly. May I start with your name?" Then pause and listen. Do not greet again, and do not ask for the name again if the caller clearly answers.',
          }));

          return;
        }

        if (event.type === 'session.instructions.appended') {
          console.log('Wysly greeting instruction accepted.');
          return;
        }

        if (event.type === 'session.output_audio.delta' && event.delta) {
          if (streamSid && connection.readyState === WebSocket.OPEN) {
            connection.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: event.delta },
            }));
          }
          return;
        }

        if (event.type === 'session.input_transcript.delta' && event.delta) {
          recordTranscript(getSession(), 'Customer', event.delta, event.start_ms, event.end_ms);
          return;
        }

        if (event.type === 'session.output_transcript.delta' && event.delta) {
          recordTranscript(getSession(), 'Wysly', event.delta, event.start_ms, event.end_ms);
          return;
        }

        if (event.type === 'error') {
          console.error('GPT-Live error:', JSON.stringify(event));
          return;
        }

        if (event.type === 'session.closed') {
          console.log('GPT-Live session closed.');
          if (liveWs?.readyState === WebSocket.OPEN) liveWs.close();
          if (callSid) finishCall(callSid);
        }
      } catch (error) {
        console.error('GPT-Live event processing error:', error);
      }
    });

    liveWs.on('error', error => {
      console.error('GPT-Live WebSocket error:', error);
    });

    liveWs.on('close', () => {
      console.log('GPT-Live WebSocket disconnected.');
      if (callSid) finishCall(callSid);
    });
  };

  connection.on('message', message => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'connected':
          console.log('Twilio stream protocol connected.');
          break;

        case 'start':
          streamSid = data.start.streamSid;
          callSid = data.start.customParameters?.callSid || data.start.callSid || null;
          callerNumber = data.start.customParameters?.callerNumber || null;

          console.log('Twilio stream started:', streamSid);
          console.log('CallSid:', callSid);
          console.log('Caller:', callerNumber);

          if (callSid && !callSessions.has(callSid)) {
            callSessions.set(callSid, {
              callSid,
              callerNumber,
              transcriptEvents: [],
              transcriptSequence: 0,
              emailSent: false,
              finishing: false,
            });
          }

          startLiveSession();
          break;

        case 'media':
          if (liveStarted && liveWs?.readyState === WebSocket.OPEN) {
            liveWs.send(JSON.stringify({
              type: 'session.input_audio.append',
              audio: data.media.payload,
            }));
          } else if (pendingAudio.length < 100) {
            pendingAudio.push(data.media.payload);
          }
          break;

        case 'stop':
          console.log('Twilio stream stopped.');
          closeLiveSession();
          if (callSid) finishCall(callSid);
          break;

        default:
          break;
      }
    } catch (error) {
      console.error('Twilio event error:', error);
    }
  });

  connection.on('close', () => {
    console.log('Twilio WebSocket disconnected.');
    closeLiveSession();
    if (callSid) finishCall(callSid);
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
