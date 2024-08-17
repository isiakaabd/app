/**
 * Step 1: Retrieve the Router's RTP Capabilities.
 * This function requests the router's RTP capabilities from the server,
 * which are essential to configure the mediasoup Device.
 * The router's RTP capabilities describe the codecs and RTP parameters supported by the router.
 * This information is crucial for ensuring that the Device is compatible with the router.
 */
// const getRouterRtpCapabilities = async () => {
//   socket.emit("getRouterRtpCapabilities", (data: any) => {
//     setRtpCapabilities(data.routerRtpCapabilities);
//     console.log(`getRouterRtpCapabilities: ${data.routerRtpCapabilities}`);
//   });
// };
