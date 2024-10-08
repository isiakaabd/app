"use client";
import { useEffect, useState, useRef } from "react";
import { Device } from "mediasoup-client";
import useSocket from "./hooks/useSocket";
import {
  DtlsParameters,
  IceCandidate,
  IceParameters,
  Transport,
} from "mediasoup-client/lib/types";

const Home = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const [params, setParams] = useState({
    encoding: [
      { rid: "r0", maxBitrate: 100000, scalabilityMode: "S1T3" }, // Lowest quality layer
      { rid: "r1", maxBitrate: 300000, scalabilityMode: "S1T3" }, // Middle quality layer
      { rid: "r2", maxBitrate: 900000, scalabilityMode: "S1T3" }, // Highest quality layer
    ],
    codecOptions: { videoGoogleStartBitrate: 1000 }, // Initial bitrate
  });
  const [device, setDevice] = useState<Device | null>(null);

  const socket = useSocket();
  const [rtpCapabilities, setRtpCapabilities] = useState<any>(null); // RTP Capabilities for the device
  const [producerTransport, setProducerTransport] = useState<Transport | null>(
    null
  ); // Transport for sending media
  const [consumerTransport, setConsumerTransport] = useState<any>(null); //
  useEffect(() => {
    socket?.on("connect", () => {
      console.log(socket, "spcket");
      // console.log({ data });
      startCamera();
    });
  }, [socket]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      console.log(stream);
      if (videoRef.current) {
        const track = stream.getVideoTracks()[0];

        videoRef.current.srcObject = stream;
        setParams((current) => ({ ...current, track }));
        // setParams((current) => ({ track, ...current }));
      }
    } catch (error) {
      console.error("Error accessing camera:", error);
    }
  };
  const createDevice = async () => {
    try {
      const newDevice = new Device();
      console.log({ newDevice });
      console.log(rtpCapabilities);
      await newDevice.load({
        routerRtpCapabilities: rtpCapabilities,
      });
      console.log({ newDevice });
      setDevice(newDevice);
    } catch (error: any) {
      console.log(error);
      if (error.name === "UnsupportedError") {
        console.error("Browser not supported");
      }
    }
  };

  const getRouterRtpCapabilities = async () => {
    socket?.emit("getRouterRtpCapabilities", (data: any) => {
      console.log(data?.rtpCapabilities);
      setRtpCapabilities(data?.rtpCapabilities);
    });
  };
  const createSendTransport = async () => {
    // Request the server to create a send transport
    socket?.emit(
      "createWebRtcTransport",
      { sender: true },
      ({
        params,
      }: {
        params: {
          id: string;

          iceParameters: IceParameters;

          iceCandidates: IceCandidate[];

          dtlsParameters: DtlsParameters;

          error?: unknown;
        };
      }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }
        console.log({ params });

        let transport = device?.createSendTransport(params);
        console.log({ transport });
        console.log({ device });
        console.log({ transport: transport?.id });
        transport?.on(
          "connect",
          async ({ dtlsParameters }: any, callback: any, errback: any) => {
            try {
              console.log("----------> producer transport has connected");
              // Notify the server that the transport is ready to connect with the provided DTLS parameters
              await socket.emit("transport-connect", {
                dtlsParameters,
              });
              // Callback to indicate success
              callback();
            } catch (error) {
              // Errback to indicate failure
              errback(error);
            }
          }
        );

        transport?.on(
          "produce",
          async (parameters: any, callback: any, errback: any) => {
            const { kind, rtpParameters, appData } = parameters;

            try {
              // Notify the server to start producing media with the provided parameters
              await socket.emit(
                "transport-produce",
                { kind, rtpParameters, appData },
                ({ id }: any) => {
                  console.log({ id });
                  // Callback to provide the server-generated producer ID back to the transport
                  callback({ id });
                }
              );
            } catch (error) {
              // Errback to indicate failure
              errback(error);
            }
          }
        );
        setProducerTransport(transport || null);
        // return transport
      }
    );
  };

  const connectSendTransport = async () => {
    console.log({ forParams: params });
    let localProducer = await producerTransport?.produce(params);
    console.log(localProducer);
    // Event handlers for track ending and transport closing events
    localProducer?.on("trackended", () => {
      console.log("trackended");
    });
    localProducer?.on("transportclose", () => {
      console.log("transportclose");
    });
  };

  const createRecvTransport = async () => {
    // Requesting the server to create a receive transport
    await socket?.emit(
      "createWebRtcTransport",
      { sender: false },
      ({ params }: { params: any }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }
        console.log(params, "send");

        // Creating a receive transport on the client-side using the server-provided parameters
        let transport = device?.createRecvTransport(params);
        console.log(transport, "recv transport");
        console.log(transport?.id, "recv transport");
        setConsumerTransport(transport);

        /**
         * This event is triggered when "consumerTransport.consume" is called
         * for the first time on the client-side.
         * */
        transport?.on(
          "connect",
          async ({ dtlsParameters }: any, callback: any, errback: any) => {
            try {
              await socket.emit("transport-recv-connect", {
                dtlsParameters,
              });
              console.log("----------> consumer transport has connected");
              callback();
            } catch (error) {
              errback(error);
            }
          }
        );
      }
    );
  };

  const connectRecvTransport = async () => {
    // Requesting the server to start consuming media
    await socket?.emit(
      "consume",
      { rtpCapabilities: device?.rtpCapabilities },
      async ({ params }: any) => {
        if (params.error) {
          console.log(params.error);
          return;
        }
        console.log(params, "received params");
        // Consuming media using the receive transport
        let consumer = await consumerTransport.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });

        // Accessing the media track from the consumer
        const { track } = consumer;
        console.log("************** track", track);

        // Attaching the media track to the remote video element for playback
        if (remoteVideoRef.current) {
          console.log({ remoteVideoRef });
          remoteVideoRef.current.srcObject = new MediaStream([track]);
          socket.emit("consumer-resume");
        }

        // Notifying the server to resume media consumption
        socket.emit("resumePausedConsumer", () => {});
        console.log("----------> consumer transport has resumed");
      }
    );
  };

  return (
    <main>
      <video
        ref={videoRef}
        disablePictureInPicture
        id="localvideo"
        autoPlay
        playsInline
      />
      <video
        ref={remoteVideoRef}
        id="remotevideo"
        style={{ width: 600, aspectRatio: 1, height: 600 }}
        autoPlay
        disablePictureInPicture
        playsInline
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <button onClick={getRouterRtpCapabilities}>
          Get Router RTP Capabilities
        </button>
        <button onClick={createDevice}>Create Device</button>
        <button onClick={createSendTransport}>Create send transport</button>
        <button onClick={connectSendTransport}>
          Connect send transport and produce
        </button>
        <button onClick={createRecvTransport}>Create recv transport</button>
        <button onClick={connectRecvTransport}>
          Connect recv transport and consume
        </button>
      </div>
    </main>
  );
};

export default Home;
