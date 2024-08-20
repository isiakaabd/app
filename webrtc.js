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
