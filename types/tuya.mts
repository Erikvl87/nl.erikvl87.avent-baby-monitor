/** The envelope every Tuya mobile API response comes in. */
export interface TuyaResponse<T> {
	success: boolean;
	result?: T;
	errorCode?: string;
	errorMsg?: string;
	t?: number;
}

/** A one-time RSA key for encrypting the password, from `thing.m.user.username.token.get`. */
export interface RsaToken {
	token: string;
	pbKey: string;
}

/** The interesting part of a successful login. `domain` holds the hosts of the data center that owns the account. */
export interface LoginResult {
	sid: string;
	uid: string;
	ecode?: string;
	partnerIdentity?: string;
	nickname?: string;
	email?: string;
	domain?: {
		mobileApiUrl?: string;
		mobileMqttsUrl?: string;
		regionCode?: string;
	};
}

export interface Home {
	gid: number | string;
	name?: string;
}

/** A device as listed by the discovery endpoints; field names differ per endpoint. */
export interface ListedDevice {
	devId?: string;
	deviceId?: string;
	id?: string;
	name?: string;
	deviceName?: string;
	productId?: string;
	productKey?: string;
	category?: string;
}

export interface Room {
	deviceList?: ListedDevice[];
}

/** A camera's state from `tuya.m.device.get`. `dps` is keyed by data point number. */
export interface DeviceDetails {
	devId: string;
	name?: string;
	productId?: string;
	isOnline?: boolean;
	localKey?: string;
	verSw?: string;
	/** Base (hardware platform) version, like "40.00". */
	bv?: string;
	dps?: Record<string, unknown>;
}

/** Everything needed to make signed requests on behalf of a signed-in account. */
export interface TuyaSession {
	sid: string;
	uid: string;
	email: string;
	apiHost: string;
	callingCode: string;
	/** The "phone" id Tuya sees. A real phone keeps one, so it is generated once per sign-in and kept. */
	phoneId: string;
	/** For the MQTT broker that carries video signalling. */
	ecode?: string;
	partnerIdentity?: string;
	mqttHost?: string;
}

/** A camera found on the account, ready to be offered for pairing. */
export interface Camera {
	id: string;
	name: string;
	productId: string;
}

export interface IceServer {
	urls: string;
	username?: string;
	credential?: string;
	ttl?: number;
}

/** What a camera needs to set up a WebRTC stream, from `smartlife.m.rtc.config.get`. */
export interface RtcConfig {
	auth: string;
	motoId: string;
	skill?: string;
	supportsWebrtc?: boolean;
	p2pConfig?: { ices?: IceServer[] };
}
