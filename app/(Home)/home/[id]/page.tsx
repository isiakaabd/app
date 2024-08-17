"use client";
import { useEffect, useRef, useState } from "react";
import io, { Socket } from "socket.io-client";
import {
  Device,
  Transport,
  DtlsParameters,
  RtpCapabilities,
} from "mediasoup-client/lib/types";
import { useRouter } from "next/router";
import useSocket from "@/app/hooks/useWebSocket";
import VideoContainer from "@/app/components/videoContainer";

const HomePage = ({ params: param }: { params: { id: string } }) => {
  const roomName = param.id;
  const localVideo = useRef<HTMLVideoElement>(null);
  const socket = useSocket();

  const deviceRef = useRef<Device | null>(null);
  const [rtpCapabilities, setRtpCapabilities] = useState<RtpCapabilities | any>(
    undefined
  );
  const [producerTransport, setProducerTransport] = useState<
    Transport | undefined
  >(undefined);
  const [consumerTransports, setConsumerTransports] = useState<any[]>([]);
  const [audioProducer, setAudioProducer] = useState<any>(null);
  const [videoProducer, setVideoProducer] = useState<any>(null);
  const [consumingTransports, setConsumingTransports] = useState<string[]>([]);

  const params = {
    encodings: [
      { rid: "r0", maxBitrate: 100000, scalabilityMode: "S1T3" },
      { rid: "r1", maxBitrate: 300000, scalabilityMode: "S1T3" },
      { rid: "r2", maxBitrate: 900000, scalabilityMode: "S1T3" },
    ],
    codecOptions: { videoGoogleStartBitrate: 1000 },
  };

  const audioParams = useRef<any>(null);
  const videoParams = useRef<any>({ params });

  useEffect(() => {
    if (!socket) return;

    socket.on("connection-success", ({ socketId }: { socketId: string }) => {
      console.log(socketId);
      getLocalStream();
    });

    socket.on("new-producer", ({ producerId }: { producerId: string }) =>
      signalNewConsumerTransport(producerId)
    );

    socket.on(
      "producer-closed",
      ({ remoteProducerId }: { remoteProducerId: string }) => {
        const producerToClose = consumerTransports.find(
          (transportData) => transportData.producerId === remoteProducerId
        );
        if (producerToClose) {
          producerToClose.consumerTransport.close();
          producerToClose.consumer.close();
          setConsumerTransports((transports) =>
            transports.filter(
              (transportData) => transportData.producerId !== remoteProducerId
            )
          );
          const videoElem = document.getElementById(`td-${remoteProducerId}`);
          if (videoElem) videoElem.remove();
        }
      }
    );

    return () => {
      socket.off("connection-success");
      socket.off("new-producer");
      socket.off("producer-closed");
    };
  }, [socket, consumerTransports]);

  const streamSuccess = (stream: MediaStream) => {
    if (localVideo.current) localVideo.current.srcObject = stream;
    audioParams.current = {
      track: stream.getAudioTracks()[0],
      ...audioParams.current,
    };
    videoParams.current = {
      track: stream.getVideoTracks()[0],
      ...videoParams.current,
    };
    joinRoom();
  };

  const joinRoom = async () => {
    socket?.emit("joinRoom", { roomName }, async (data: any) => {
      setRtpCapabilities(data.rtpCapabilities);
      await createDevice(data.rtpCapabilities);
    });
  };

  const getLocalStream = () => {
    navigator.mediaDevices
      .getUserMedia({
        audio: true,
        video: {
          width: { min: 640, max: 1920 },
          height: { min: 400, max: 1080 },
        },
      })
      .then(streamSuccess)
      .catch((error) => console.log(error.message));
  };

  const createDevice = async (rtpCapabilities: RtpCapabilities) => {
    try {
      const newDevice = new Device();
      await newDevice.load({ routerRtpCapabilities: rtpCapabilities });
      console.log("Device created", newDevice);
      deviceRef.current = newDevice;
      createSendTransport(newDevice);
    } catch (error: any) {
      console.log(error);
      if (error.name === "UnsupportedError")
        console.warn("Browser not supported");
    }
  };

  const createSendTransport = (newDevice: Device) => {
    socket?.emit(
      "createWebRtcTransport",
      { consumer: false },
      ({ params }: { params: any }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }

        const newProducerTransport = newDevice.createSendTransport(params);
        console.log({ newProducerTransport });
        newProducerTransport?.on(
          "connect",
          async (
            { dtlsParameters }: { dtlsParameters: DtlsParameters },
            callback,
            errback
          ) => {
            try {
              await socket?.emit("transport-connect", { dtlsParameters });
              callback();
            } catch (error: any) {
              errback(error);
            }
          }
        );

        newProducerTransport?.on(
          "produce",
          async (
            parameters: any,
            callback: ({ id }: { id: string }) => void,
            errback: (error: Error) => void
          ) => {
            console.log({ parameters });
            try {
              await socket?.emit(
                "transport-produce",
                {
                  kind: parameters.kind,
                  rtpParameters: parameters.rtpParameters,
                  appData: parameters.appData,
                },
                ({
                  id,
                  producersExist,
                }: {
                  id: string;
                  producersExist: boolean;
                }) => {
                  callback({ id });
                  if (producersExist) {
                    getProducers();
                  }
                }
              );
            } catch (error: any) {
              errback(error);
            }
          }
        );

        setProducerTransport(newProducerTransport);
        connectSendTransport(newProducerTransport);
      }
    );
  };

  const connectSendTransport = async (transport: Transport) => {
    const currentDevice = deviceRef.current;
    if (!currentDevice) {
      console.error("Device not initialized");
      return;
    }

    const newAudioProducer = await transport.produce(audioParams.current);
    const newVideoProducer = await transport.produce(videoParams.current);

    newAudioProducer?.on("trackended", () => console.log("audio track ended"));
    newAudioProducer?.on("transportclose", () =>
      console.log("audio transport ended")
    );

    newVideoProducer?.on("trackended", () => console.log("video track ended"));
    newVideoProducer?.on("transportclose", () =>
      console.log("video transport ended")
    );

    setAudioProducer(newAudioProducer);
    setVideoProducer(newVideoProducer);
  };

  const signalNewConsumerTransport = async (remoteProducerId: string) => {
    const currentDevice = deviceRef.current;
    if (!currentDevice) {
      console.error("Device not initialized");
      return;
    }

    if (consumingTransports.includes(remoteProducerId)) return;
    setConsumingTransports((prev) => [...prev, remoteProducerId]);

    await socket?.emit(
      "createWebRtcTransport",
      { consumer: true },
      ({ params }: { params: any }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }
        console.log(`PARAMS... ${params}`);

        let consumerTransport;
        try {
          consumerTransport = currentDevice.createRecvTransport(params);
        } catch (error: any) {
          console.log(error);
          return;
        }

        consumerTransport?.on(
          "connect",
          async (
            { dtlsParameters }: { dtlsParameters: DtlsParameters },
            callback,
            errback
          ) => {
            try {
              await socket.emit("transport-recv-connect", {
                dtlsParameters,
                serverConsumerTransportId: params.id,
              });
              callback();
            } catch (error: any) {
              errback(error);
            }
          }
        );

        connectRecvTransport(consumerTransport, remoteProducerId, params.id);
      }
    );
  };

  const connectRecvTransport = async (
    consumerTransport: Transport,
    remoteProducerId: string,
    serverConsumerTransportId: string
  ) => {
    const currentDevice = deviceRef.current;
    if (!currentDevice) {
      console.error("Device not initialized");
      return;
    }

    await socket?.emit(
      "consume",
      {
        rtpCapabilities: currentDevice.rtpCapabilities,
        remoteProducerId,
        serverConsumerTransportId,
      },
      async ({ params }: { params: any }) => {
        if (params.error) {
          console.log("Cannot Consume");
          return;
        }

        const newConsumer = await consumerTransport?.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });
        console.log(`newConsumer ${newConsumer}`);
        setConsumerTransports((prev) => [
          ...prev,
          {
            consumerTransport,
            serverConsumerTransportId: params.id,
            producerId: remoteProducerId,
            consumer: newConsumer,
          },
        ]);

        const newElem = document.createElement("div");
        newElem.setAttribute("id", `td-${remoteProducerId}`);
        if (params.kind === "audio") {
          newElem.innerHTML = `<audio id="${remoteProducerId}" muted autoplay></audio>`;
        } else {
          newElem.setAttribute("class", "remoteVideo");
          newElem.innerHTML = `<video id="${remoteProducerId}" autoplay class="video"></video>`;
        }
        document.getElementById("videoContainer")?.appendChild(newElem);
        const x = document.getElementById(remoteProducerId);
        console.log("xxx", x);
        document.getElementById(remoteProducerId)!.srcObject = new MediaStream([
          newConsumer.track,
        ]);
        socket.emit("consumer-resume", {
          serverConsumerId: params.serverConsumerId,
        });
      }
    );
  };

  const getProducers = () => {
    socket?.emit("getProducers", (producerIds: string[]) => {
      console.log(producerIds);
      producerIds.forEach(signalNewConsumerTransport);
    });
  };

  return (
    <div>
      <h1>{roomName}</h1>
      <video ref={localVideo} autoPlay muted className="localVideo"></video>
      <VideoContainer consumerTransports={consumerTransports} />
    </div>
  );
};

export default HomePage;
