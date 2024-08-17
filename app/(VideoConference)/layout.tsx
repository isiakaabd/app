"use client";
import { useEffect, useState, useRef } from "react";
import { Device } from "mediasoup-client";
import useSocket from "../hooks/useSocket";

const SharedScreen = () => {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const socket = useSocket();
  console.log(socket, "socket");
  const [producer, setProducer] = useState<any>(null);
  const [rtpCapabilities, setRtpCapabilities] = useState<any>(null);
  const [consumer, setConsumer] = useState<any>(null);

  useEffect(() => {
    if (socket) {
      const loadDevice = async () => {
        const device = new Device();
        setDevice(device);

        socket.emit(
          "getRouterRtpCapabilities",
          async (rtpCapabilities: any) => {
            await device.load({ routerRtpCapabilities: rtpCapabilities });

            socket.emit("createTransport", (transportInfo: any) => {
              const transport = device.createSendTransport(transportInfo);

              transport.on(
                "connect",
                ({ dtlsParameters }, callback, errback) => {
                  socket.emit(
                    "connectTransport",
                    { dtlsParameters },
                    callback,
                    errback
                  );
                }
              );

              transport.on(
                "produce",
                ({ kind, rtpParameters }, callback, errback) => {
                  socket.emit(
                    "produce",
                    { kind, rtpParameters },
                    (response: any) => {
                      setProducer(response.id);
                      callback(response);
                    }
                  );
                }
              );

              transport.on("connectionstatechange", (state) => {
                if (state === "connected") {
                  console.log("Transport connected");
                } else if (state === "failed") {
                  console.error("Transport connection failed");
                  transport.close();
                }
              });

              getLocalStream().then((stream) => {
                const track = stream.getVideoTracks()[0];
                localVideoRef.current!.srcObject = stream;

                transport.produce({ track });
              });
            });
          }
        );
      };

      const getLocalStream = async () => {
        return await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
      };

      loadDevice();
    }
  }, [socket]);

  useEffect(() => {
    if (device && producer) {
      socket?.emit("createTransport", (transportInfo: any) => {
        const transport = device.createRecvTransport(transportInfo);

        transport.on("connect", ({ dtlsParameters }, callback, errback) => {
          socket?.emit(
            "connectTransport",
            { dtlsParameters },
            callback,
            errback
          );
        });

        transport.on("connectionstatechange", (state) => {
          if (state === "connected") {
            console.log("Transport connected");
          } else if (state === "failed") {
            console.error("Transport connection failed");
            transport.close();
          }
        });

        socket.emit(
          "consume",
          { producerId: producer, rtpCapabilities: device.rtpCapabilities },
          (consumerInfo: any) => {
            if (consumerInfo.error) {
              console.error(consumerInfo.error);
              return;
            }

            const consumer = transport.consume({
              id: consumerInfo.id,
              producerId: consumerInfo.producerId,
              kind: consumerInfo.kind,
              rtpParameters: consumerInfo.rtpParameters,
            });

            setConsumer(consumer);

            const stream = new MediaStream();
            stream.addTrack(consumer.track);
            remoteVideoRef.current!.srcObject = stream;
          }
        );
      });
    }
  }, [device, producer, socket]);
  const createDevice = async () => {
    try {
      const device = new Device();

      setDevice(device);

      await device.load({ routerRtpCapabilities: rtpCapabilities });
    } catch (error: any) {
      console.log(error);
      if (error.name === "UnsupportedError") {
        console.error("Browser not supported");
      }
    }
  };
  

  return (
    <div>
      <h1>Mediasoup Audio/Video Sharing</h1>
      <video ref={localVideoRef} autoPlay muted playsInline></video>
      <video ref={remoteVideoRef} autoPlay playsInline></video>
    </div>
    <button></button>
  );
};

export { SharedScreen };
