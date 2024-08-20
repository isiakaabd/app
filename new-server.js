import { Server } from "socket.io";
import mediasoup from "mediasoup";
import next from "next";
import * as os from "os";
import * as fs from "fs";
import { createServer } from "https";

// Define environment and server settings
const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = 5000;

// Function to create the HTTPS server with optional SSL/TLS key and certificate
const createHttpsServer = (app, options) => {
  if (options && options.key && options.cert) {
    return createServer({ key: options.key, cert: options.cert }, app);
  } else {
    throw new Error("SSL/TLS key and certificate are required.");
  }
};

// Load SSL/TLS key and certificate
const key = fs.readFileSync("cert.key");
const cert = fs.readFileSync("cert.crt");

const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

// Global variables for managing rooms, peers, transports, producers, and consumers
let worker;
let rooms = {};
let peers = {};
let transports = [];
let producers = [];
let consumers = [];

// Function to create a Mediasoup worker
const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000); // Exit in 2 seconds
  });

  return worker;
};

// Start the Mediasoup worker when the application starts
worker = createWorker();

// Define the media codecs supported by Mediasoup
const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

app.prepare().then(() => {
  // Create HTTPS server
  const httpServer = createHttpsServer(handler, { key, cert });

  const io = new Server(httpServer, {
    cors: {
      origin: "https://localhost:3000",
      methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
    },
  });

  io.on("connection", async (socket) => {
    socket.emit("connection-success", {
      socketId: socket.id,
    });

    const removeItems = (items, socketId, type) => {
      items.forEach((item) => {
        if (item.socketId === socketId) {
          item[type].close();
        }
      });
      return items.filter((item) => item.socketId !== socketId);
    };

    socket.on("disconnect", () => {
      console.log("peer disconnected");
      consumers = removeItems(consumers, socket.id, "consumer");
      producers = removeItems(producers, socket.id, "producer");
      transports = removeItems(transports, socket.id, "transport");

      if (peers[socket.id]) {
        const { roomName } = peers[socket.id];
        delete peers[socket.id];
        rooms[roomName] = {
          router: rooms[roomName].router,
          peers: rooms[roomName].peers.filter(
            (socketId) => socketId !== socket.id
          ),
        };
      }
    });

    socket.on("joinRoom", async ({ roomName }, callback) => {
      const router = await createRoom(roomName, socket.id);

      peers[socket.id] = {
        socket,
        roomName,
        transports: [],
        producers: [],
        consumers: [],
        peerDetails: {
          name: "",
          isAdmin: false,
        },
      };

      const rtpCapabilities = router.rtpCapabilities;
      callback({ rtpCapabilities });
    });

    const createRoom = async (roomName, socketId) => {
      let router;
      let peers = [];

      if (rooms[roomName]) {
        router = rooms[roomName].router;
        peers = rooms[roomName].peers || [];
      } else {
        router = await worker.createRouter({ mediaCodecs });
      }

      rooms[roomName] = {
        router,
        peers: [...peers, socketId],
      };

      return router;
    };

    socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
      const roomName = peers[socket.id].roomName;
      const router = rooms[roomName].router;

      createWebRtcTransport(router).then(
        (transport) => {
          callback({
            params: {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            },
          });
          addTransport(transport, roomName, consumer);
        },
        (error) => {
          console.log(error);
        }
      );
    });

    const addTransport = (transport, roomName, consumer) => {
      transports = [
        ...transports,
        { socketId: socket.id, transport, roomName, consumer },
      ];

      peers[socket.id] = {
        ...peers[socket.id],
        transports: [...peers[socket.id].transports, transport.id],
      };
    };

    const addProducer = (producer, roomName) => {
      producers = [...producers, { socketId: socket.id, producer, roomName }];

      peers[socket.id] = {
        ...peers[socket.id],
        producers: [...peers[socket.id].producers, producer.id],
      };
    };

    const addConsumer = (consumer, roomName) => {
      consumers = [...consumers, { socketId: socket.id, consumer, roomName }];

      peers[socket.id] = {
        ...peers[socket.id],
        consumers: [...peers[socket.id].consumers, consumer.id],
      };
    };

    socket.on("getProducers", (callback) => {
      const { roomName } = peers[socket.id];
      let producerList = [];

      producers.forEach((producerData) => {
        if (
          producerData.socketId !== socket.id &&
          producerData.roomName === roomName
        ) {
          producerList = [...producerList, producerData.producer.id];
        }
      });

      callback(producerList);
    });

    const informConsumers = (roomName, socketId, id) => {
      producers.forEach((producerData) => {
        if (
          producerData.socketId !== socketId &&
          producerData.roomName === roomName
        ) {
          const producerSocket = peers[producerData.socketId].socket;
          producerSocket.emit("new-producer", { producerId: id });
        }
      });
    };

    const getTransport = (socketId) => {
      return transports.find(
        (transport) => transport.socketId === socketId && !transport.consumer
      ).transport;
    };

    socket.on("transport-connect", ({ dtlsParameters }) => {
      getTransport(socket.id).connect({ dtlsParameters });
    });

    socket.on(
      "transport-produce",
      async ({ kind, rtpParameters, appData }, callback) => {
        const producer = await getTransport(socket.id).produce({
          kind,
          rtpParameters,
        });

        const { roomName } = peers[socket.id];
        addProducer(producer, roomName);
        informConsumers(roomName, socket.id, producer.id);

        producer.on("transportclose", () => {
          producer.close();
        });

        callback({
          id: producer.id,
          producersExist: producers.length > 1,
        });
      }
    );

    socket.on(
      "transport-recv-connect",
      async ({ dtlsParameters, serverConsumerTransportId }) => {
        const consumerTransport = transports.find(
          (transportData) =>
            transportData.consumer &&
            transportData.transport.id === serverConsumerTransportId
        ).transport;
        await consumerTransport.connect({ dtlsParameters });
      }
    );

    socket.on(
      "consume",
      async (
        { rtpCapabilities, remoteProducerId, serverConsumerTransportId },
        callback
      ) => {
        try {
          const { roomName } = peers[socket.id];
          const router = rooms[roomName].router;
          const consumerTransport = transports.find(
            (transportData) =>
              transportData.consumer &&
              transportData.transport.id === serverConsumerTransportId
          ).transport;

          if (
            router.canConsume({
              producerId: remoteProducerId,
              rtpCapabilities,
            })
          ) {
            const consumer = await consumerTransport.consume({
              producerId: remoteProducerId,
              rtpCapabilities,
              paused: true,
            });

            consumer.on("transportclose", () => {
              console.log("transport close from consumer");
            });

            consumer.on("producerclose", () => {
              socket.emit("producer-closed", { remoteProducerId });

              consumerTransport.close([]);
              transports = transports.filter(
                (transportData) =>
                  transportData.transport.id !== consumerTransport.id
              );
              consumer.close();
              consumers = consumers.filter(
                (consumerData) => consumerData.consumer.id !== consumer.id
              );
            });

            addConsumer(consumer, roomName);

            callback({
              params: {
                id: consumer.id,
                producerId: remoteProducerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
              },
            });
          }
        } catch (error) {
          console.log(error.message);
          callback({
            params: {
              error: error,
            },
          });
        }
      }
    );

    socket.on("consumer-resume", async ({ serverConsumerId }) => {
      const { consumer } = consumers?.find(
        (consumerData) => consumerData.consumer.id === serverConsumerId
      );
      await consumer.resume();
    });
  });

  httpServer.listen(port, hostname, () => {
    console.log(`> Server listening at https://${hostname}:${port}`);
  });
});
// does your code have this part

const createWebRtcTransport = async (router) => {
  const listenIps = [];

  if (typeof window === "undefined") {
    const networkInterfaces = os.networkInterfaces();

    if (networkInterfaces) {
      for (const addresses of Object.values(networkInterfaces)) {
        addresses.forEach((address) => {
          if (address.family === "IPv4") {
            listenIps.push({ ip: address.address, announcedIp: null });
          } else if (address.family === "IPv6" && address.address[0] !== "f") {
            listenIps.push({ ip: address.address, announcedIp: null });
          }
        });
      }
    }
  }

  if (listenIps.length === 0) {
    listenIps.push({ ip: "127.0.0.1", announcedIp: null });
  }

  const webRtcTransportOptions = {
    listenIps: listenIps,
    // enableTcp: true,
    // preferUdp: true,
  };

  console.log(webRtcTransportOptions);
  const transport = await router.createWebRtcTransport(webRtcTransportOptions);

  transport.on("dtlsstatechange", (dtlsState) => {
    if (dtlsState === "closed") {
      transport.close();
    }
  });

  transport.on("@close", () => {
    console.log("transport closed");
  });

  return transport;
};
