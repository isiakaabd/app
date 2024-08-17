import { createServer } from "node:http";
import next from "next";
import * as mediasoup from "mediasoup";
import { Server } from "socket.io";
const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = 3000;
// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();
let worker;
let router;
let producerTransport;
let consumerTransport;
let producer;
let consumer;
const mediaCodecs = [
  {
    /** Indicates this is an audio codec configuration */
    kind: "audio",

    mimeType: "audio/opus",

    clockRate: 48000,
    /** Specifies the number of audio channels (2 for stereo audio). */
    channels: 2,

    preferredPayloadType: 96, // Example value

    rtcpFeedback: [
      // Example values
      { type: "nack" },
      { type: "nack", parameter: "pli" },
    ],
  },
  {
    kind: "video",
    /** Specifies the MIME type for the VP8 codec, commonly used for video compression. */
    mimeType: "video/VP8",
    /** Specifies the clock rate, or the number of timing ticks per second (commonly 90,000 for video). */
    clockRate: 90000,

    parameters: {
      "x-google-start-bitrate": 1000,
    },
    preferredPayloadType: 97, // Example value
    rtcpFeedback: [
      // Example values
      { type: "nack" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
    ],
  },
];

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000, // Minimum port number for RTC traffic
    rtcMaxPort: 2020, // Maximum port number for RTC traffic
  });

  // Log the worker process ID for reference
  console.log(`Worker process ID ${worker.pid}`);

  // Event handler for the 'died' event on the worker
  worker.on("died", (error) => {
    console.error("mediasoup worker has died");
    // Gracefully shut down the process to allow for recovery or troubleshooting
    setTimeout(() => {
      process.exit();
    }, 2000);
  });

  return worker;
};
worker = createWorker();
app.prepare().then(() => {
  const httpServer = createServer(handler);

  const io = new Server(httpServer);

  io.on("connection", async (socket) => {
    router = await worker.createRouter({ mediaCodecs });

    socket.emit("connection-success", {
      socketId: socket.id,
    });

    socket.on("disconnect", () => {
      console.log("peer disconnected");
    });
    socket.on("getRouterRtpCapabilities", async (callback) => {
      const rtpCapabilities = await router.rtpCapabilities;

      callback({ rtpCapabilities });
    });
    socket.on("createWebRtcTransport", async ({ sender }, callback) => {
      console.log(`Is this a sender request? ${sender}`);
      if (sender) producerTransport = await createWebRtcTransport(callback);
      else consumerTransport = await createWebRtcTransport(callback);
    });
    socket.on("transport-connect", async ({ id, dtlsParameters }) => {
      console.log("DTLS PARAMS... ", { dtlsParameters });
      console.log("TransportId... ", { id });
      await producerTransport.connect({ dtlsParameters });
    });
    socket.on(
      "transport-produce",
      async ({ kind, rtpParameters }, callback) => {
        producer = await producerTransport?.produce({
          kind,
          rtpParameters,
        });
        console.log({ producer });
        producer?.on("transportclose", () => {
          console.log("Producer transport closed");
          producer?.close();
        });

        callback({ id: producer?.id });
      }
    );
    socket.on("connectProducerTransport", async ({ dtlsParameters }) => {
      await producerTransport?.connect({ dtlsParameters });
    });

    socket.on("transport-recv-connect", async ({ dtlsParameters }) => {
      await consumerTransport?.connect({ dtlsParameters });
    });

    socket.on("consume", async ({ rtpCapabilities }, callback) => {
      console.log({ producer });
      try {
        //  if (producer) {
        // Check if the router can consume the media from the producer based on the RTP capabilities
        if (router.canConsume({ producerId: producer?.id, rtpCapabilities })) {
          console.error("Cannot consume");
          return;
        }
        console.log("-------> consume");

        // Create a consumer on the consumer transport
        consumer = await consumerTransport?.consume({
          producerId: producer?.id,
          rtpCapabilities,
          // Pause the consumer initially if it's a video consumer
          // This can help save bandwidth until the video is actually needed
          paused: true, // producer?.kind === "video",
        });

        // Event handler for transport closure
        // This helps ensure that resources are cleaned up when the transport is closed
        consumer?.on("transportclose", () => {
          console.log("Consumer transport closed");
          consumer?.close();
        });

        // Event handler for producer closure
        // This helps ensure that the consumer is closed when the producer is closed
        consumer?.on("producerclose", () => {
          console.log("Producer closed");
          consumer?.close();
        });

        // Invoke the callback with the consumer parameters
        // This allows the client to configure the consumer on its end
        callback({
          params: {
            producerId: producer?.id,
            id: consumer?.id,
            kind: consumer?.kind,
            rtpParameters: consumer?.rtpParameters,
          },
        });
        // }
      } catch (error) {
        // Handle any errors that occur during the consume process
        console.error("Error consuming:", error);
        callback({
          params: {
            error,
          },
        });
      }
    });
    socket.on("consumer-resume", async () => {
      try {
        await consumer.resume();
      } catch (error) {
        // Handle any errors that occur during the consume process
        console.error("Error consuming:", error);
      }
    });
  });

  httpServer
    .once("error", (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
    });
});
const createWebRtcTransport = async (callback) => {
  try {
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
    const webRtcTransport_options = {
      listenIps: [
        {
          ip: "0.0.0.0", // replace with relevant IP address
          announcedIp: "127.0.0.1",
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    };

    // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
    let transport = await router.createWebRtcTransport(webRtcTransport_options);
    console.log(`transport id: ${transport.id}`);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("close", () => {
      console.log("transport closed");
    });
    console.log(transport, "transport closed");
    // send back to the client the following prameters
    callback({
      // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });

    return transport;
  } catch (error) {
    console.log(error);
    callback({
      params: {
        error: error,
      },
    });
  }
};
