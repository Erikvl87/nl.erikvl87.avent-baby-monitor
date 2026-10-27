/**
 * The parts of Homey's video API the app uses (Homey 12.7+). The `homey-apps-sdk-v3-types` package doesn't describe
 * them yet.
 */
export interface WebRtcAnswer {
	answerSdp: string;
	streamId?: string;
}

export interface VideoWebRtc {
	registerOfferListener(listener: (offerSdp: string) => Promise<WebRtcAnswer>): void;
}

export interface ManagerVideos {
	createVideoWebRTC(options?: { dataChannel?: boolean }): Promise<VideoWebRtc>;
}

export interface HomeyWithVideos {
	videos?: ManagerVideos;
}

export interface DeviceWithVideo {
	setCameraVideo(id: string, title: string, video: VideoWebRtc): Promise<void>;
}
