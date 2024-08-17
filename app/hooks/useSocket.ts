"use client";
import { useEffect, useState } from "react";
import io, { Socket } from "socket.io-client";

const useSocket = (): Socket | null => {
  const [socket, setSocket] = useState<Socket | null>(null);
  console.log(process, "DDDDD");

  useEffect(() => {
    // Create and configure the socket instance
    const socketInstance = io(process.env.URL ?? ""); //"https://mediasoup-demo-server.onrender.com"

    // Define the event handlers
    const onConnect = () => {
      console.log("Connected to server");
    };

    // Attach event handlers to the socket
    socketInstance.on("connect", onConnect);

    // Set the socket instance to state
    setSocket(socketInstance);

    // Clean up the socket connection on unmount
    return () => {
      socketInstance.disconnect();
    };
  }, []); // Empty dependency array ensures this runs once on mount

  return socket;
};

export default useSocket;
