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
type Type = "consumer" | "producer" | "";
const Home = () => {
  const [isProducer, setIsProducer] = useState<Type>("");

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
  const goConnect = (type: Type) => {
    setIsProducer(type);
    getRouterRtpCapabilities();
  };
  const goCreateTransport = () => {
    isProducer === "consumer" ? createSendTransport() : createRecvTransport();
  };
  const socket = useSocket();
  const [rtpCapabilities, setRtpCapabilities] = useState<any>(null); // RTP Capabilities for the device
  const [producerTransport, setProducerTransport] = useState<Transport | null>(
    null
  ); // Transport for sending media
  const [consumerTransport, setConsumerTransport] = useState<any>(null); // Transport for receiving media
  const selectConsumer = () => setIsProducer("consumer");
  const selectProducer = () => setIsProducer("producer");
  useEffect(() => {
    socket?.on("connect", async () => {
      await startCamera();
      await getRouterRtpCapabilities();
      await createDevice();
      await createSendTransport();
      await connectSendTransport();
      await createRecvTransport();
      await connectRecvTransport();
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
      }
    } catch (error) {
      console.error("Error accessing camera:", error);
    }
  };

  const createDevice = async () => {
    try {
      const newDevice = new Device();
      await newDevice.load({
        routerRtpCapabilities: rtpCapabilities,
      });
      console.log({ newDevice });
      setDevice(newDevice);
      goCreateTransport();
    } catch (error: any) {
      console.log(error);
      if (error.name === "UnsupportedError") {
        console.error("Browser not supported");
      }
    }
  };

  const getRouterRtpCapabilities = async () => {
    await socket?.emit("createRoom", (data: any) => {
      console.log(data?.rtpCapabilities);
      setRtpCapabilities(data?.rtpCapabilities);
      createDevice();
    });
  };

  const createSendTransport = async () => {
    await socket?.emit(
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
              await socket.emit("transport-connect", {
                dtlsParameters,
              });
              callback();
            } catch (error) {
              errback(error);
            }
          }
        );

        transport?.on(
          "produce",
          async (parameters: any, callback: any, errback: any) => {
            const { kind, rtpParameters, appData } = parameters;
            try {
              await socket.emit(
                "transport-produce",
                { kind, rtpParameters, appData },
                ({ id }: any) => {
                  console.log({ id });
                  callback({ id });
                }
              );
            } catch (error) {
              errback(error);
            }
          }
        );
        connectSendTransport();
        setProducerTransport(transport || null);
      }
    );
  };

  const connectSendTransport = async () => {
    console.log({ forParams: params });
    let localProducer = await producerTransport?.produce(params);
    console.log(localProducer);
    localProducer?.on("trackended", () => {
      console.log("trackended");
    });
    localProducer?.on("transportclose", () => {
      console.log("transportclose");
    });
  };

  const createRecvTransport = async () => {
    await socket?.emit(
      "createWebRtcTransport",
      { sender: false },
      ({ params }: { params: any }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }
        console.log(params, "send");
        let transport = device?.createRecvTransport(params);
        console.log(transport, "recv transport");
        console.log(transport?.id, "recv transport");
        setConsumerTransport(transport);

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
    await socket?.emit(
      "consume",
      { rtpCapabilities: device?.rtpCapabilities },
      async ({ params }: any) => {
        if (params.error) {
          console.log(params.error);
          return;
        }
        console.log(params, "received params");
        let consumer = await consumerTransport.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });
        const { track } = consumer;
        console.log("************** track", track);

        if (remoteVideoRef.current) {
          console.log({ remoteVideoRef });
          remoteVideoRef.current.srcObject = new MediaStream([track]);
          socket.emit("consumer-resume");
        }
        socket.emit("resumePausedConsumer", () => {});
        console.log("----------> consumer transport has resumed");
      }
    );
  };

  return (
    <main className="flex flex-col gap-8">
      <div className="flex gap-2 flex-nowrap">
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
      </div>

      {isProducer === "" && (
        <div className="flex gap-2 flex-nowrap">
          <button
            style={{
              backgroundColor: "white",
              paddingInline: "1.4em",
              color: "#333",
              cursor: "pointer",
              paddingBlock: "1.2em",
            }}
            className="mr-2 bg-white p-2 py-2"
            onClick={selectProducer}
          >
            Be A Publisher
          </button>
          <button
            style={{
              backgroundColor: "white",
              paddingInline: "1.4em",
              color: "#333",
              cursor: "pointer",
              paddingBlock: "1.2em",
            }}
            className="mr-2 bg-white px-3 py-2"
            onClick={selectConsumer}
          >
            Be A Consumer
          </button>
        </div>
      )}
      <div className="flex gap-2">
        {isProducer === "producer" && (
          <button
            style={{
              backgroundColor: "white",
              paddingInline: "1.4em",
              color: "#333",
              cursor: "pointer",
              paddingBlock: "1.2em",
              width: "max-content",
            }}
            className="mr-2 bg-white px-3 py-2"
          >
            Publish
          </button>
        )}
        {isProducer === "consumer" && (
          <button
            style={{
              backgroundColor: "white",
              paddingInline: "1.4em",
              color: "#333",
              cursor: "pointer",
              paddingBlock: "1.2em",
              width: "max-content",
            }}
            className="mr-2 bg-white px-3 py-2"
          >
            Consume
          </button>
        )}
      </div>
    </main>
  );
};

export default Home;
