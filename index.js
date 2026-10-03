import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import nodemailer from 'nodemailer';

// Load environment variables
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
    console.warn('Gmail settings are missing. Calls will work, but email summaries may not send.');
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---------------------------------------------------------
// CLAIRE - FIX IT AFTER-HOURS RECEPTIONIST
// ---------------------------------------------------------

const SYSTEM_MESSAGE = `
You are Claire, the after-hours receptionist for Fix It Appliance Service.

Fix It Appliance Service is a premium, professional in-home appliance repair company. Your job is to make every caller feel welcomed, respected, and taken care of, even though the office is currently closed.

Your personality:
- Warm, polished, calm, confident, and friendly.
- Sound like an experienced receptionist at a high-end service company.
- Never sound robotic, overly cheerful, scripted, or rushed.
- Speak clearly and slightly slower than normal.
- Use short, natural sentences.
- Ask only one question at a time.
- Listen carefully and acknowledge what the customer says before moving to the next question.
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
- If the customer already gives multiple pieces of information, remember them and do not ask for them again.
- Acknowledge problems naturally with phrases such as:
  "I understand."
  "I'm sorry you're dealing with that."
  "Thank you, that helps."
  "I'll make sure our office has that information."
- Never overuse apologies.
- Do not repeatedly say "thank you" after every answer.
- If the caller sounds frustrated, slow down and be especially calm and helpful.
- If the customer says they already had a technician visit or the appliance is still having the same problem, clearly treat it as an existing service concern or callback.

Important rules:
- Never diagnose the appliance.
- Never guess which part is bad.
- Never promise a repair price.
- Never promise an appointment time.
- Never promise warranty coverage.
- Never criticize another technician, manufacturer, or service company.
- Never argue with a customer.
- Never invent information.
- If you do not understand something, politely ask the caller to repeat or clarify it.

Safety:
If the caller reports fire, smoke, sparking, a gas smell, active flooding, or another immediate hazard, advise them to stop using the appliance if it is safe to do so and contact the appropriate emergency, utility, plumbing, or other professional service. Do not troubleshoot an active safety hazard.

If asked whether you are AI:
Be honest and relaxed. Say:
"I'm Claire, Fix It's automated after-hours receptionist. I'm here to make sure our office gets all the information they need to help you."
Then continue naturally. Do not make a big issue of being automated.

Language rules:
- Always speak in English.
- Never switch to another language because of the customer's accent, pronunciation, name, address, appliance brand, or isolated word.
- Names such as Sallam, Wisam, Mahdi, Mozzi, Elijah, Brevan, LG, Samsung, Frigidaire, Midea, and appliance terms must not trigger a language change.
- If a word is unclear, stay in English and politely ask the caller to repeat or spell it.
- If the customer speaks another language, continue in English and say the after-hours service is currently available in English.
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
- If a customer's name is unclear, stay in English and ask:
  "Could you please spell your first name for me?"
- Never guess a customer's name.
- Never change languages because a name sounds foreign.

At the end of the call:
- Briefly confirm the customer's name, callback number, appliance, and main problem.
- Do not repeat every detail unless clarification is needed.
- Tell the customer that the Fix It office team will review the request and follow up when the office reopens.
- End warmly and professionally.

Never discuss unrelated topics, jokes, politics, general trivia, or subjects unrelated to Fix It Appliance Service.
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

async function sendAfterHoursEmail(callTranscript, callerNumber) {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
        console.log('Gmail configuration missing. Email not sent.');
        return;
    }

    if (!callTranscript || callTranscript.length === 0) {
        console.log('No transcript available. Email not sent.');
        return;
    }

    const transcriptText = callTranscript.join('\n\n');

    try {
        await mailTransporter.sendMail({
            from: `"Fix It After-Hours" <${GMAIL_USER}>`,
            to: 'techniciansfixit@gmail.com',
            subject: `New Fix It After-Hours Call${callerNumber ? ` - ${callerNumber}` : ''}`,
            text: `NEW AFTER-HOURS SERVICE CALL

Caller Number: ${callerNumber || 'Not available'}

CALL TRANSCRIPT
----------------------------------------

${transcriptText}

----------------------------------------

This message was automatically created by Claire,
Fix It Appliance Service After-Hours Receptionist.
`
        });

        console.log('After-hours email sent successfully.');
    } catch (error) {
        console.error('Error sending after-hours email:', error);
    }
}

// ---------------------------------------------------------
// LOGGING
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
// ROOT ROUTE
// ---------------------------------------------------------

fastify.get('/', async (request, reply) => {
    reply.send({
        message: 'Fix It Claire After-Hours Receptionist is running!'
    });
});

// ---------------------------------------------------------
// TWILIO INCOMING CALL
// ---------------------------------------------------------

fastify.all('/incoming-call', async (request, reply) => {

    const callerNumber =
        request.body?.From ||
        request.query?.From ||
        'Unknown';

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Google.en-US-Chirp3-HD-Aoede">Thank you for calling Fix It Appliance Service. Our office is currently closed, but Claire, our after-hours receptionist, can take care of your service request and make sure our office has everything they need to follow up with you.</Say>

    <Pause length="1"/>

    <Say voice="Google.en-US-Chirp3-HD-Aoede">Hi, this is Claire. May I start with your name?</Say>

    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream">
            <Parameter name="callerNumber" value="${callerNumber}" />
        </Stream>
    </Connect>
</Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// ---------------------------------------------------------
// MEDIA STREAM
// ---------------------------------------------------------

fastify.register(async (fastify) => {

    fastify.get(
        '/media-stream',
        { websocket: true },
        (connection, req) => {

            console.log('Client connected');

            let streamSid = null;
            let latestMediaTimestamp = 0;
            let lastAssistantItem = null;
            let markQueue = [];
            let responseStartTimestampTwilio = null;

            let callTranscript = [];
            let callerNumber = null;
            let emailSent = false;

            const openAiWs = new WebSocket(
                `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
                {
                    headers: {
                        Authorization: `Bearer ${OPENAI_API_KEY}`
                    }
                }
            );

            // -------------------------------------------------
            // INITIALIZE OPENAI SESSION
            // -------------------------------------------------

            const initializeSession = () => {

                const sessionUpdate = {
                    type: 'session.update',

                    session: {
                        type: 'realtime',

                        model: 'gpt-realtime',

                        output_modalities: ['audio'],

                        audio: {

                            input: {
                                format: {
                                    type: 'audio/pcmu'
                                },

                                transcription: {
                                    model: 'gpt-transcribe'
                                },

                                turn_detection: {
                                    type: 'server_vad'
                                }
                            },

                            output: {
                                format: {
                                    type: 'audio/pcmu'
                                },

                                voice: VOICE
                            }
                        },

                        instructions: SYSTEM_MESSAGE
                    }
                };

                console.log('Sending session update');

                openAiWs.send(
                    JSON.stringify(sessionUpdate)
                );
            };

            // -------------------------------------------------
            // HANDLE CUSTOMER INTERRUPTIONS
            // -------------------------------------------------

            const handleSpeechStartedEvent = () => {

                if (
                    markQueue.length > 0 &&
                    responseStartTimestampTwilio != null
                ) {

                    const elapsedTime =
                        latestMediaTimestamp -
                        responseStartTimestampTwilio;

                    if (SHOW_TIMING_MATH) {
                        console.log(
                            `Elapsed time: ${elapsedTime}ms`
                        );
                    }

                    if (lastAssistantItem) {

                        const truncateEvent = {
                            type: 'conversation.item.truncate',
                            item_id: lastAssistantItem,
                            content_index: 0,
                            audio_end_ms: elapsedTime
                        };

                        openAiWs.send(
                            JSON.stringify(truncateEvent)
                        );
                    }

                    connection.send(
                        JSON.stringify({
                            event: 'clear',
                            streamSid: streamSid
                        })
                    );

                    markQueue = [];
                    lastAssistantItem = null;
                    responseStartTimestampTwilio = null;
                }
            };

            // -------------------------------------------------
            // TWILIO MARKS
            // -------------------------------------------------

            const sendMark = (
                connection,
                streamSid
            ) => {

                if (!streamSid) return;

                const markEvent = {
                    event: 'mark',

                    streamSid: streamSid,

                    mark: {
                        name: 'responsePart'
                    }
                };

                connection.send(
                    JSON.stringify(markEvent)
                );

                markQueue.push('responsePart');
            };

            // -------------------------------------------------
            // OPENAI CONNECTED
            // -------------------------------------------------

            openAiWs.on('open', () => {

                console.log(
                    'Connected to OpenAI Realtime API'
                );

                setTimeout(
                    initializeSession,
                    100
                );
            });

            // -------------------------------------------------
            // OPENAI EVENTS
            // -------------------------------------------------

            openAiWs.on('message', (data) => {

                try {

                    const response =
                        JSON.parse(data);

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

                        callTranscript.push(
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

                        callTranscript.push(
                            `Claire: ${response.transcript}`
                        );
                    }

                    // CLAIRE AUDIO
                    if (
                        response.type ===
                            'response.output_audio.delta' &&
                        response.delta
                    ) {

                        const audioDelta = {
                            event: 'media',

                            streamSid: streamSid,

                            media: {
                                payload:
                                    response.delta
                            }
                        };

                        connection.send(
                            JSON.stringify(
                                audioDelta
                            )
                        );

                        if (
                            !responseStartTimestampTwilio
                        ) {
                            responseStartTimestampTwilio =
                                latestMediaTimestamp;
                        }

                        if (response.item_id) {
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
            });

            // -------------------------------------------------
            // TWILIO EVENTS
            // -------------------------------------------------

            connection.on(
                'message',
                (message) => {

                    try {

                        const data =
                            JSON.parse(message);

                        switch (data.event) {

                            case 'media':

                                latestMediaTimestamp =
                                    data.media.timestamp;

                                if (
                                    openAiWs.readyState ===
                                    WebSocket.OPEN
                                ) {

                                    openAiWs.send(
                                        JSON.stringify({
                                            type:
                                                'input_audio_buffer.append',

                                            audio:
                                                data.media.payload
                                        })
                                    );
                                }

                                break;

                            case 'start':

                                streamSid =
                                    data.start.streamSid;

                                callerNumber =
                                    data.start
                                        .customParameters
                                        ?.callerNumber ||
                                    null;

                                console.log(
                                    'Incoming stream started',
                                    streamSid
                                );

                                console.log(
                                    'Caller:',
                                    callerNumber
                                );

                                responseStartTimestampTwilio =
                                    null;

                                latestMediaTimestamp =
                                    0;

                                break;

                            case 'mark':

                                if (
                                    markQueue.length > 0
                                ) {
                                    markQueue.shift();
                                }

                                break;

                            default:

                                console.log(
                                    'Received event:',
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
            // CALL ENDS
            // -------------------------------------------------

            connection.on(
                'close',
                () => {

                    console.log(
                        'Customer disconnected.'
                    );

                    // Give OpenAI a moment to finish the final
                    // transcription before sending the email.
                    setTimeout(
                        async () => {

                            if (!emailSent) {

                                emailSent = true;

                                await sendAfterHoursEmail(
                                    callTranscript,
                                    callerNumber
                                );
                            }

                            if (
                                openAiWs.readyState ===
                                WebSocket.OPEN
                            ) {
                                openAiWs.close();
                            }

                        },
                        1500
                    );
                }
            );

            // -------------------------------------------------
            // OPENAI CLOSE / ERROR
            // -------------------------------------------------

            openAiWs.on(
                'close',
                () => {
                    console.log(
                        'Disconnected from OpenAI Realtime API'
                    );
                }
            );

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
});

// ---------------------------------------------------------
// START SERVER - REQUIRED FOR RENDER
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
