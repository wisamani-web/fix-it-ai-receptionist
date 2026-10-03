import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import nodemailer from 'nodemailer';

dotenv.config();

const {
    OPENAI_API_KEY,
    GMAIL_USER,
    GMAIL_APP_PASSWORD
} = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY.');
    process.exit(1);
}

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.warn(
        'Gmail settings are missing. Calls will work, but emails may not send.'
    );
}

const fastify = Fastify();

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---------------------------------------------------------
// ACTIVE CALL STORAGE
// ---------------------------------------------------------

const callSessions = new Map();

// ---------------------------------------------------------
// CLAIRE
// ---------------------------------------------------------

const SYSTEM_MESSAGE = `
You are Claire, the after-hours receptionist for Fix It Appliance Service.

Fix It Appliance Service is a premium, professional in-home appliance repair company.

Your job is to make every caller feel welcomed, respected, comfortable, and taken care of even though the office is currently closed.

IMPORTANT START-OF-CALL CONTEXT:
Before you receive the caller's first audio, the telephone system has already said:
"Thank you for calling Fix It Appliance Service..."
and:
"Hi, this is Claire. May I start with your name?"

Therefore:
- DO NOT greet the caller again.
- DO NOT introduce yourself again.
- DO NOT say "How can I help you?" as your first response.
- Treat the caller's first spoken response as their answer to the name question.
- Acknowledge their name naturally and continue to the next appropriate question.

Your personality:
- Warm, polished, calm, confident, and friendly.
- Sound like an experienced receptionist at a high-end service company.
- Never sound robotic, scripted, rushed, or overly cheerful.
- Speak clearly and slightly slower than normal.
- Use short, natural sentences.
- Ask only one question at a time.
- Listen carefully.
- Acknowledge what the customer says before moving on.
- Use the customer's name naturally, but not excessively.
- Avoid phrases that sound like a call center or automated system.

Your role is to take a complete service request for the office.

Collect:
1. Customer's full name.
2. Best callback phone number.
3. Service address and city.
4. Appliance type.
5. Appliance brand, if known.
6. A clear description of the problem.
7. Whether this is a new service request or an existing Fix It customer/job.
8. If this is an existing job, ask whether a Fix It technician has already visited.
9. Best time for the office to call them back.

Conversation style:
- Do not interrogate the customer with a checklist.
- Make the conversation feel natural.
- If the customer already gives multiple pieces of information, remember them.
- Never ask for information they already provided.
- Acknowledge problems naturally with phrases such as:
  "I understand."
  "I'm sorry you're dealing with that."
  "Thank you, that helps."
  "I'll make sure our office has that information."
- Do not say thank you after every answer.
- Do not overuse apologies.
- If the caller sounds frustrated, slow down and be especially calm and helpful.
- If the customer says a Fix It technician already visited or the appliance has the same problem again, treat it as an existing service concern or possible callback.

Important rules:
- Never diagnose the appliance.
- Never guess which part is bad.
- Never promise a repair price.
- Never promise an appointment time.
- Never promise warranty coverage.
- Never criticize a technician, manufacturer, or another service company.
- Never argue with a customer.
- Never invent information.
- If something is unclear, politely ask the caller to repeat or clarify it.

Safety:
If the caller reports fire, smoke, sparking, a gas smell, active flooding, or another immediate hazard:
- Advise them to stop using the appliance if it is safe to do so.
- Advise them to contact the appropriate emergency, utility, plumbing, or other professional service.
- Do not troubleshoot an active safety hazard.

If asked whether you are AI:
Be honest and relaxed. Say:
"I'm Claire, Fix It's automated after-hours receptionist. I'm here to make sure our office gets all the information they need to help you."
Then continue naturally.

Language rules:
- Always speak in English.
- Never switch languages because of an accent, name, address, brand, pronunciation, or isolated word.
- Names such as Sallam, Wisam, Mahdi, Mozzi, Elijah, and Brevan must not trigger another language.
- LG, Samsung, Frigidaire, Electrolux, GE, Midea, Sharp, and Speed Queen must not trigger another language.
- If a word is unclear, stay in English and ask the caller to repeat or spell it.
- Never automatically switch languages.

Common appliance vocabulary:
- fridge means refrigerator
- refrigerator
- freezer
- washer means washing machine
- washing machine
- dryer
- dishwasher
- range
- stove
- oven
- microwave
- ice maker
- not cooling
- not heating
- leaking
- noisy
- not draining
- not spinning

Name handling:
- If a customer's name is unclear, ask:
  "Could you please spell your first name for me?"
- Never guess a customer's name.
- Never change languages because a name sounds foreign.

At the end:
- Briefly confirm the customer's name, callback number, appliance, and main problem.
- Do not repeat every detail unless clarification is needed.
- Tell the customer the Fix It office team will review the request and follow up when the office reopens.
- End warmly and professionally.

Never discuss unrelated topics, jokes, politics, trivia, or subjects unrelated to Fix It Appliance Service.
`;

const VOICE = 'marin';
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050;

// ---------------------------------------------------------
// EMAIL
// ---------------------------------------------------------

const mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD
    }
});

async function sendAfterHoursEmail(session) {

    if (!session) {
        console.log('No call session found. Email not sent.');
        return;
    }

    if (session.emailSent) {
        console.log('Email already sent for this call.');
        return;
    }

    // Prevent duplicate attempts
    session.emailSent = true;

    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
        console.log('Gmail configuration missing. Email not sent.');
        return;
    }

    if (!session.transcript || session.transcript.length === 0) {
        console.log('No transcript available. Email not sent.');
        session.emailSent = false;
        return;
    }

    const transcriptText =
        session.transcript.join('\n\n');

    try {

        await mailTransporter.sendMail({
            from: `"Fix It After-Hours" <${GMAIL_USER}>`,

            to: 'techniciansfixit@gmail.com',

            subject:
                `New Fix It After-Hours Call - ${
                    session.callerNumber || 'Unknown Caller'
                }`,

            text: `NEW AFTER-HOURS SERVICE CALL

Caller Number:
${session.callerNumber || 'Not available'}

CALL TRANSCRIPT
==================================================

${transcriptText}

==================================================

Automatically created by Claire
Fix It Appliance Service
After-Hours Receptionist
`
        });

        console.log(
            'After-hours email sent successfully.'
        );

    } catch (error) {

        session.emailSent = false;

        console.error(
            'Error sending after-hours email:',
            error
        );
    }
}

// ---------------------------------------------------------
// FINISH A CALL
// ---------------------------------------------------------

async function finishCall(callSid) {

    if (!callSid) {
        console.log(
            'Cannot finish call because CallSid is missing.'
        );
        return;
    }

    const session =
        callSessions.get(callSid);

    if (!session) {
        console.log(
            `No stored session found for ${callSid}.`
        );
        return;
    }

    if (session.emailSent) {
        return;
    }

    console.log(
        `Preparing after-hours email for ${callSid}.`
    );

    // Allow final transcription events to arrive.
    await new Promise(resolve =>
        setTimeout(resolve, 2000)
    );

    await sendAfterHoursEmail(session);

    // Keep it temporarily in case another Twilio callback arrives.
    setTimeout(() => {
        callSessions.delete(callSid);
        console.log(
            `Cleaned up call session ${callSid}.`
        );
    }, 60000);
}

// ---------------------------------------------------------
// LOG EVENTS
// ---------------------------------------------------------

const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.completed',
    'response.output_audio_transcript.done',
    'session.created',
    'session.updated'
];

const SHOW_TIMING_MATH = false;

// ---------------------------------------------------------
// ROOT
// ---------------------------------------------------------

fastify.get('/', async (request, reply) => {

    reply.send({
        message:
            'Fix It Claire After-Hours Receptionist is running!'
    });
});

// ---------------------------------------------------------
// INCOMING TWILIO CALL
// ---------------------------------------------------------

fastify.all(
    '/incoming-call',

    async (request, reply) => {

        const callerNumber =
            request.body?.From ||
            request.query?.From ||
            'Unknown';

        const callSid =
            request.body?.CallSid ||
            request.query?.CallSid ||
            `unknown-${Date.now()}`;

        callSessions.set(
            callSid,
            {
                callSid,
                callerNumber,
                transcript: [],
                emailSent: false
            }
        );

        console.log(
            `Incoming call ${callSid} from ${callerNumber}`
        );

        const twimlResponse =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>

    <Say voice="Google.en-US-Chirp3-HD-Aoede">
        Thank you for calling Fix It Appliance Service. Our office is currently closed, but Claire, our after-hours receptionist, can take care of your service request and make sure our office has everything they need to follow up with you.
    </Say>

    <Pause length="1"/>

    <Say voice="Google.en-US-Chirp3-HD-Aoede">
        Hi, this is Claire. May I start with your name?
    </Say>

    <Connect action="/call-ended" method="POST">

        <Stream url="wss://${request.headers.host}/media-stream">

            <Parameter
                name="callerNumber"
                value="${callerNumber}"
            />

            <Parameter
                name="callSid"
                value="${callSid}"
            />

        </Stream>

    </Connect>

</Response>`;

        reply
            .type('text/xml')
            .send(twimlResponse);
    }
);

// ---------------------------------------------------------
// TWILIO CONNECT ACTION
// THIS RUNS WHEN <CONNECT> ENDS
// ---------------------------------------------------------

fastify.all(
    '/call-ended',

    async (request, reply) => {

        const callSid =
            request.body?.CallSid ||
            request.query?.CallSid;

        console.log(
            'Twilio /call-ended callback received:',
            callSid
        );

        if (callSid) {
            finishCall(callSid);
        }

        // End call cleanly.
        reply
            .type('text/xml')
            .send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`
            );
    }
);

// ---------------------------------------------------------
// MEDIA STREAM
// ---------------------------------------------------------

fastify.register(
    async (fastify) => {

        fastify.get(
            '/media-stream',
            {
                websocket: true
            },

            (connection, req) => {

                console.log(
                    'Media Stream client connected.'
                );

                let streamSid = null;
                let callSid = null;
                let callerNumber = null;

                let latestMediaTimestamp = 0;
                let lastAssistantItem = null;
                let markQueue = [];
                let responseStartTimestampTwilio =
                    null;

                let localTranscript = [];

                const openAiWs =
                    new WebSocket(
                        `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
                        {
                            headers: {
                                Authorization:
                                    `Bearer ${OPENAI_API_KEY}`
                            }
                        }
                    );

                // -------------------------------------------------
                // GET CURRENT SESSION
                // -------------------------------------------------

                const getCurrentSession = () => {

                    if (
                        callSid &&
                        callSessions.has(callSid)
                    ) {

                        return callSessions.get(
                            callSid
                        );
                    }

                    return null;
                };

                // -------------------------------------------------
                // SAVE TRANSCRIPT LINE
                // -------------------------------------------------

                const addTranscript =
                    (line) => {

                        localTranscript.push(
                            line
                        );

                        const session =
                            getCurrentSession();

                        if (session) {

                            session.transcript.push(
                                line
                            );
                        }
                    };

                // -------------------------------------------------
                // INITIALIZE OPENAI
                // -------------------------------------------------

                const initializeSession =
                    () => {

                        const sessionUpdate = {

                            type:
                                'session.update',

                            session: {

                                type:
                                    'realtime',

                                model:
                                    'gpt-realtime',

                                output_modalities:
                                    ['audio'],

                                audio: {

                                    input: {

                                        format: {
                                            type:
                                                'audio/pcmu'
                                        },

                                        transcription: {
                                            model:
                                                'gpt-transcribe'
                                        },

                                        turn_detection: {
                                            type:
                                                'server_vad'
                                        }
                                    },

                                    output: {

                                        format: {
                                            type:
                                                'audio/pcmu'
                                        },

                                        voice:
                                            VOICE
                                    }
                                },

                                instructions:
                                    SYSTEM_MESSAGE
                            }
                        };

                        console.log(
                            'Sending OpenAI session update.'
                        );

                        openAiWs.send(
                            JSON.stringify(
                                sessionUpdate
                            )
                        );
                    };

                // -------------------------------------------------
                // INTERRUPTION
                // -------------------------------------------------

                const handleSpeechStartedEvent =
                    () => {

                        if (
                            markQueue.length > 0 &&
                            responseStartTimestampTwilio !=
                                null
                        ) {

                            const elapsedTime =
                                latestMediaTimestamp -
                                responseStartTimestampTwilio;

                            if (
                                SHOW_TIMING_MATH
                            ) {
                                console.log(
                                    `Elapsed: ${elapsedTime}`
                                );
                            }

                            if (
                                lastAssistantItem
                            ) {

                                openAiWs.send(
                                    JSON.stringify({
                                        type:
                                            'conversation.item.truncate',

                                        item_id:
                                            lastAssistantItem,

                                        content_index:
                                            0,

                                        audio_end_ms:
                                            elapsedTime
                                    })
                                );
                            }

                            connection.send(
                                JSON.stringify({
                                    event:
                                        'clear',

                                    streamSid:
                                        streamSid
                                })
                            );

                            markQueue = [];

                            lastAssistantItem =
                                null;

                            responseStartTimestampTwilio =
                                null;
                        }
                    };

                // -------------------------------------------------
                // SEND MARK
                // -------------------------------------------------

                const sendMark =
                    (
                        connection,
                        currentStreamSid
                    ) => {

                        if (
                            !currentStreamSid
                        ) {
                            return;
                        }

                        connection.send(
                            JSON.stringify({
                                event:
                                    'mark',

                                streamSid:
                                    currentStreamSid,

                                mark: {
                                    name:
                                        'responsePart'
                                }
                            })
                        );

                        markQueue.push(
                            'responsePart'
                        );
                    };

                // -------------------------------------------------
                // OPENAI OPEN
                // -------------------------------------------------

                openAiWs.on(
                    'open',
                    () => {

                        console.log(
                            'Connected to OpenAI Realtime API.'
                        );

                        setTimeout(
                            initializeSession,
                            100
                        );
                    }
                );

                // -------------------------------------------------
                // OPENAI MESSAGE
                // -------------------------------------------------

                openAiWs.on(
                    'message',
                    (data) => {

                        try {

                            const response =
                                JSON.parse(
                                    data
                                );

                            if (
                                LOG_EVENT_TYPES.includes(
                                    response.type
                                )
                            ) {

                                console.log(
                                    `Received event: ${response.type}`
                                );
                            }

                            // CUSTOMER TRANSCRIPT
                            if (
                                response.type ===
                                    'conversation.item.input_audio_transcription.completed' &&
                                response.transcript
                            ) {

                                console.log(
                                    'Customer:',
                                    response.transcript
                                );

                                addTranscript(
                                    `Customer: ${response.transcript}`
                                );
                            }

                            // CLAIRE TRANSCRIPT
                            if (
                                response.type ===
                                    'response.output_audio_transcript.done' &&
                                response.transcript
                            ) {

                                console.log(
                                    'Claire:',
                                    response.transcript
                                );

                                addTranscript(
                                    `Claire: ${response.transcript}`
                                );
                            }

                            // CLAIRE AUDIO
                            if (
                                response.type ===
                                    'response.output_audio.delta' &&
                                response.delta
                            ) {

                                connection.send(
                                    JSON.stringify({
                                        event:
                                            'media',

                                        streamSid:
                                            streamSid,

                                        media: {
                                            payload:
                                                response.delta
                                        }
                                    })
                                );

                                if (
                                    !responseStartTimestampTwilio
                                ) {

                                    responseStartTimestampTwilio =
                                        latestMediaTimestamp;
                                }

                                if (
                                    response.item_id
                                ) {

                                    lastAssistantItem =
                                        response.item_id;
                                }

                                sendMark(
                                    connection,
                                    streamSid
                                );
                            }

                            if (
                                response.type ===
                                'input_audio_buffer.speech_started'
                            ) {

                                handleSpeechStartedEvent();
                            }

                        } catch (error) {

                            console.error(
                                'Error processing OpenAI message:',
                                error
                            );
                        }
                    }
                );

                // -------------------------------------------------
                // TWILIO MESSAGE
                // -------------------------------------------------

                connection.on(
                    'message',
                    (message) => {

                        try {

                            const data =
                                JSON.parse(
                                    message
                                );

                            switch (
                                data.event
                            ) {

                                case 'connected':

                                    console.log(
                                        'Twilio Media Stream connected.'
                                    );

                                    break;

                                case 'start':

                                    streamSid =
                                        data.start
                                            .streamSid;

                                    callSid =
                                        data.start
                                            .customParameters
                                            ?.callSid ||
                                        null;

                                    callerNumber =
                                        data.start
                                            .customParameters
                                            ?.callerNumber ||
                                        null;

                                    console.log(
                                        'Incoming stream started:',
                                        streamSid
                                    );

                                    console.log(
                                        'CallSid:',
                                        callSid
                                    );

                                    console.log(
                                        'Caller:',
                                        callerNumber
                                    );

                                    // If for some reason incoming-call storage
                                    // was not available, create it here.
                                    if (
                                        callSid &&
                                        !callSessions.has(
                                            callSid
                                        )
                                    ) {

                                        callSessions.set(
                                            callSid,
                                            {
                                                callSid,
                                                callerNumber,
                                                transcript:
                                                    localTranscript,
                                                emailSent:
                                                    false
                                            }
                                        );
                                    }

                                    responseStartTimestampTwilio =
                                        null;

                                    latestMediaTimestamp =
                                        0;

                                    break;

                                case 'media':

                                    latestMediaTimestamp =
                                        data.media
                                            .timestamp;

                                    if (
                                        openAiWs.readyState ===
                                        WebSocket.OPEN
                                    ) {

                                        openAiWs.send(
                                            JSON.stringify({
                                                type:
                                                    'input_audio_buffer.append',

                                                audio:
                                                    data.media
                                                        .payload
                                            })
                                        );
                                    }

                                    break;

                                case 'mark':

                                    if (
                                        markQueue.length >
                                        0
                                    ) {

                                        markQueue.shift();
                                    }

                                    break;

                                case 'stop':

                                    console.log(
                                        'Twilio stream stopped.'
                                    );

                                    if (callSid) {

                                        finishCall(
                                            callSid
                                        );
                                    }

                                    break;

                                default:

                                    console.log(
                                        'Received Twilio event:',
                                        data.event
                                    );

                                    break;
                            }

                        } catch (error) {

                            console.error(
                                'Error parsing Twilio message:',
                                error
                            );
                        }
                    }
                );

                // -------------------------------------------------
                // WEBSOCKET CLOSE FALLBACK
                // -------------------------------------------------

                connection.on(
                    'close',
                    () => {

                        console.log(
                            'Twilio WebSocket disconnected.'
                        );

                        if (callSid) {

                            finishCall(
                                callSid
                            );
                        }

                        if (
                            openAiWs.readyState ===
                            WebSocket.OPEN
                        ) {

                            openAiWs.close();
                        }
                    }
                );

                // -------------------------------------------------
                // OPENAI CLOSE
                // -------------------------------------------------

                openAiWs.on(
                    'close',
                    () => {

                        console.log(
                            'Disconnected from OpenAI Realtime API.'
                        );
                    }
                );

                // -------------------------------------------------
                // OPENAI ERROR
                // -------------------------------------------------

                openAiWs.on(
                    'error',
                    (error) => {

                        console.error(
                            'OpenAI WebSocket error:',
                            error
                        );
                    }
                );
            }
        );
    }
);

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------

fastify.listen(
    {
        port: PORT,
        host: '0.0.0.0'
    },

    (err) => {

        if (err) {

            console.error(err);

            process.exit(1);
        }

        console.log(
            `Server is listening on port ${PORT}`
        );
    }
);
