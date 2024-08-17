import React from "react";

interface VideoContainerProps {
  consumerTransports: {
    consumerTransport: any;
    serverConsumerTransportId: string;
    producerId: string;
    consumer: any;
  }[];
}

const VideoContainer: React.FC<VideoContainerProps> = ({
  consumerTransports,
}) => {
  return (
    <div id="videoContainer">
      {consumerTransports.map((transport) => (
        <div
          key={transport.producerId}
          id={`td-${transport.producerId}`}
          className="remoteVideo"
        >
          <video id={transport.producerId} autoPlay className="video"></video>
        </div>
      ))}
    </div>
  );
};

export default VideoContainer;
