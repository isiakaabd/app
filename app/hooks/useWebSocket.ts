import { useEffect, useState } from "react";
import io, { Socket } from "socket.io-client";

const useSocket = (): Socket | null => {
  const [socket, setSocket] = useState<Socket | null>(null);
  console.log(process.env.NEXT_PUBLIC_URL, "DDDDD");

  useEffect(() => {
    const newSocket = io(process.env.NEXT_PUBLIC_URL ?? ""); //"https://mediasoup-demo-server.onrender.com"

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, []);

  return socket;
};

export default useSocket;
