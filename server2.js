import { Server } from "socket.io";
import mediasoup from "mediasoup";
import next from "next";
import * as os from "os";
import * as fs from "fs";
import { createServer } from "https";
const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = 5000;
const key = fs.readFileSync("cert.key");
const cert = fs.readFileSync("cert.crt");

// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

// const io = new Server(httpsServer);
//
// socket.io namespace (could represent a room?)
// const connections = io.of("/mediasoup");
// Function to create the HTTPS server with optional SSL/TLS key and certificate
const createHttpsServer = (app, options) => {
  if (options && options.key && options.cert) {
    return createServer({ key: options.key, cert: options.cert }, app);
  } else {
    throw new Error("SSL/TLS key and certificate are required.");
  }
};

let worker;
let rooms = {}; // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
let peers = {}; // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []; // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []; // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []; // [ { socketId1, roomName1, consumer, }, ... ]

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    // This implies something serious happened, so kill the application
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
  });

  return worker;
};

// We create a Worker as soon as our application starts
worker = createWorker();

// This is an Array of RtpCapabilities
// https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability
// list of media codecs supported by mediasoup ...
// https://github.com/versatica/mediasoup/blob/v3/src/supportedRtpCapabilities.ts
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
        if (item.socketId === socket.id) {
          item[type].close();
        }
      });
      items = items.filter((item) => item.socketId !== socket.id);

      return items;
    };

    socket.on("disconnect", () => {
      // do some cleanup
      console.log("peer disconnected");
      consumers = removeItems(consumers, socket.id, "consumer");
      producers = removeItems(producers, socket.id, "producer");
      transports = removeItems(transports, socket.id, "transport");
      console.log({ peers: peers[socket.id] });
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

      // remove socket from room
    });
    socket.on("joinRoom", async ({ roomName }, callback) => {
      // create Router if it does not exist
      // const router1 = rooms[roomName] && rooms[roomName].get('data').router || await createRoom(roomName, socket.id)
      const router1 = await createRoom(roomName, socket.id);

      peers[socket.id] = {
        socket,
        roomName, // Name for the Router this Peer joined
        transports: [],
        producers: [],
        consumers: [],
        peerDetails: {
          name: "",
          isAdmin: false, // Is this Peer the Admin?
        },
      };

      // get Router RTP Capabilities
      const rtpCapabilities = router1.rtpCapabilities;

      callback({ rtpCapabilities });
    });

    const createRoom = async (roomName, socketId) => {
      let router1;
      let peers = [];
      if (rooms[roomName]) {
        router1 = rooms[roomName].router;
        peers = rooms[roomName].peers || [];
      } else {
        router1 = await worker.createRouter({ mediaCodecs });
      }

      rooms[roomName] = {
        router: router1,
        peers: [...peers, socketId],
      };

      return router1;
    };

    // socket.on('createRoom', async (callback) => {
    //   if (router === undefined) {

    socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
      // get Room Name from Peer's properties
      const roomName = peers[socket.id].roomName;

      // get Router (Room) object this peer is in based on RoomName
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

          // add transport to Peer's properties
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
      // add the consumer to the consumers list
      consumers = [...consumers, { socketId: socket.id, consumer, roomName }];

      // add the consumer id to the peers list
      peers[socket.id] = {
        ...peers[socket.id],
        consumers: [...peers[socket.id].consumers, consumer.id],
      };
    };

    socket.on("getProducers", (callback) => {
      //return all producer transports
      const { roomName } = peers[socket.id];

      let producerList = [];
      const x = producers.forEach((producerData) => {
        if (
          producerData.socketId !== socket.id &&
          producerData.roomName === roomName
        ) {
          producerList = [...producerList, producerData.producer.id];
        }
      });
      console.log({ x });

      // return the producer list back to the client
      callback(producerList);
    });

    const informConsumers = (roomName, socketId, id) => {
      console.log(`just joined, id ${id} ${roomName}, ${socketId}`);
      // A new producer just joined
      // let all consumers to consume this producer
      producers.forEach((producerData) => {
        if (
          producerData.socketId !== socketId &&
          producerData.roomName === roomName
        ) {
          const producerSocket = peers[producerData.socketId].socket;
          // use socket to send producer id to producer
          producerSocket.emit("new-producer", { producerId: id });
        }
      });
    };

    const getTransport = (socketId) => {
      const [producerTransport] = transports.filter(
        (transport) => transport.socketId === socketId && !transport.consumer
      );
      return producerTransport.transport;
    };

    // see client's socket.emit('transport-connect', ...)
    socket.on("transport-connect", ({ dtlsParameters }) => {
      console.log("DTLS PARAMS... ", { dtlsParameters });

      getTransport(socket.id).connect({ dtlsParameters });
    });

    // see client's socket.emit('transport-produce', ...)
    socket.on(
      "transport-produce",
      async ({ kind, rtpParameters, appData }, callback) => {
        // call produce based on the prameters from the client
        const producer = await getTransport(socket.id).produce({
          kind,
          rtpParameters,
        });

        // add producer to the producers array
        const { roomName } = peers[socket.id];

        addProducer(producer, roomName);

        informConsumers(roomName, socket.id, producer.id);

        console.log("Producer ID: ", producer.id, producer.kind);

        producer.on("transportclose", () => {
          console.log("transport for this producer closed ");
          producer.close();
        });

        // Send back to the client the Producer's id
        callback({
          id: producer.id,
          producersExist: producers.length > 1 ? true : false,
        });
      }
    );

    // see client's socket.emit('transport-recv-connect', ...)
    socket.on(
      "transport-recv-connect",
      async ({ dtlsParameters, serverConsumerTransportId }) => {
        console.log(`DTLS PARAMS: ${dtlsParameters}`);
        const consumerTransport = transports.find(
          (transportData) =>
            transportData.consumer &&
            transportData.transport.id == serverConsumerTransportId
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
          let consumerTransport = transports.find(
            (transportData) =>
              transportData.consumer &&
              transportData.transport.id == serverConsumerTransportId
          ).transport;

          // check if the router can consume the specified producer
          if (
            router.canConsume({
              producerId: remoteProducerId,
              rtpCapabilities,
            })
          ) {
            // transport can now consume and return a consumer
            const consumer = await consumerTransport.consume({
              producerId: remoteProducerId,
              rtpCapabilities,
              paused: true,
            });

            consumer.on("transportclose", () => {
              console.log("transport close from consumer");
            });

            consumer.on("producerclose", () => {
              console.log("producer of consumer closed");
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

            // from the consumer extract the following params
            // to send back to the Client
            const params = {
              id: consumer.id,
              producerId: remoteProducerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              serverConsumerId: consumer.id,
            };

            // send the parameters to the client
            callback({ params });
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
      const { consumer } = consumers.find(
        (consumerData) => consumerData.consumer.id === serverConsumerId
      );
      await consumer.resume();
    });
  });
  httpServer
    .once("error", (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`> Ready on https://${hostname}:${port}`);
    });
});

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
    enableTcp: true,
    preferUdp: true,
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
// const createWebRtcTransport = async (router) => {
//   return new Promise(async (resolve, reject) => {
//     try {
//       // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
//       const webRtcTransport_options = {
//         listenIps: [
//           {
//             ip: "0.0.0.0", // replace with relevant IP address
//             announcedIp: "127.0.0.1",
//           },
//         ],
//         enableUdp: true,
//         enableTcp: true,
//         preferUdp: true,
//       };

//       // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
//       let transport = await router.createWebRtcTransport(
//         webRtcTransport_options
//       );
//       console.log(`transport id: ${transport.id}`);

//       transport.on("dtlsstatechange", (dtlsState) => {
//         if (dtlsState === "closed") {
//           transport.close();
//         }
//       });

//       transport.on("close", () => {
//         console.log("transport closed");
//       });

//       resolve(transport);
//     } catch (error) {
//       reject(error);
//     }
//   });
// };
