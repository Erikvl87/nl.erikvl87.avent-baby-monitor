import { describe, it, expect } from 'vitest';
import { lullabies, lullabyForTrackId, readTrackId, trackIdFor, trackValue } from '../../utils/lullaby.mjs';
import { blockOf, trackIdInBlock } from '../../utils/lullaby.mjs';

describe('lullabies', () => {
	it('has the 15 sounds in id order', () => {
		expect(lullabies).toHaveLength(15);
		expect(lullabies[0]).toBe('baa_baa_black_sheep');
		expect(lullabies[14]).toBe('rain_shower');
	});
});

describe('readTrackId', () => {
	it('reads the id from the JSON string the camera reports', () => {
		expect(readTrackId('{"bizcode":"phi-no-bm","id":3542155}')).toBe(3542155);
	});

	it('reads the id when the quotes come escaped, as an SCD951 reports it through the cloud', () => {
		expect(readTrackId('{\\"bizcode\\":\\"phi-no-bm\\",\\"id\\":17807426,\\"errcode\\":0}')).toBe(17807426);
	});

	it('reads the id when the JSON is encoded twice', () => {
		expect(readTrackId(JSON.stringify('{"bizcode":"phi-no-bm","id":3542155}'))).toBe(3542155);
	});

	it('reads the id from an already parsed object', () => {
		expect(readTrackId({ bizcode: 'phi-no-bm', id: 12072930 })).toBe(12072930);
	});

	it('returns undefined for invalid JSON', () => {
		expect(readTrackId('{"id":')).toBeUndefined();
		expect(readTrackId('')).toBeUndefined();
	});

	it('returns undefined when there is no integer id', () => {
		expect(readTrackId('{"bizcode":"phi-no-bm"}')).toBeUndefined();
		expect(readTrackId('{"id":"3542154"}')).toBeUndefined();
		expect(readTrackId('{"id":3542154.5}')).toBeUndefined();
		expect(readTrackId('null')).toBeUndefined();
		expect(readTrackId(null)).toBeUndefined();
		expect(readTrackId(undefined)).toBeUndefined();
	});
});

describe('lullabyForTrackId', () => {
	it('maps the blocks measured on an SCD973 on firmware 1.4.0 and an SCD951', () => {
		expect(lullabyForTrackId(4848444)).toBe('baa_baa_black_sheep');
		expect(lullabyForTrackId(4848458)).toBe('rain_shower');
		expect(lullabyForTrackId(17807426)).toBe('baa_baa_black_sheep');
		expect(lullabyForTrackId(17807440)).toBe('rain_shower');
		// The SCD973's extra sound, between its last and first, is none of the known ones.
		expect(lullabyForTrackId(7964640)).toBeUndefined();
	});

	it('maps the first id of the original block to the first sound', () => {
		expect(lullabyForTrackId(3542154)).toBe('baa_baa_black_sheep');
	});

	it('maps the last id of the second block to the last sound', () => {
		expect(lullabyForTrackId(12072916 + 14)).toBe('rain_shower');
	});

	it('maps ids in the third block', () => {
		expect(lullabyForTrackId(3219038 + 1)).toBe('brahms_lullaby');
	});

	it('returns undefined for ids just outside a block', () => {
		expect(lullabyForTrackId(3542154 - 1)).toBeUndefined();
		expect(lullabyForTrackId(3542154 + 15)).toBeUndefined();
		expect(lullabyForTrackId(12072916 + 15)).toBeUndefined();
	});

	it('returns undefined without an id', () => {
		expect(lullabyForTrackId(undefined)).toBeUndefined();
	});
});

describe('trackIdFor', () => {
	it('uses the original block when the current id is unknown', () => {
		expect(trackIdFor('baa_baa_black_sheep', undefined)).toBe(3542154);
		expect(trackIdFor('rain_shower', undefined)).toBe(3542154 + 14);
	});

	it('keeps the block of the current id', () => {
		expect(trackIdFor('heartbeat', 12072916 + 3)).toBe(12072916 + 7);
		expect(trackIdFor('white_noise', 3219038)).toBe(3219038 + 9);
		expect(trackIdFor('brahms_lullaby', 3542154 + 10)).toBe(3542154 + 1);
	});

	it('falls back to the original block when the current id is in no block', () => {
		expect(trackIdFor('calming_river', 999)).toBe(3542154 + 6);
	});

	it('returns undefined for an unknown sound', () => {
		expect(trackIdFor('twinkle_twinkle', 3542154)).toBeUndefined();
	});

	it('round-trips with lullabyForTrackId for every sound and block', () => {
		for (const current of [undefined, 3542154, 12072916, 3219038]) {
			for (const lullaby of lullabies) {
				expect(lullabyForTrackId(trackIdFor(lullaby, current))).toBe(lullaby);
			}
		}
	});
});

describe('trackValue', () => {
	it('builds the JSON the camera expects', () => {
		expect(trackValue(3542155)).toBe('{"bizcode":"phi-no-bm","id":3542155}');
	});

	it('round-trips with readTrackId', () => {
		expect(readTrackId(trackValue(12072930))).toBe(12072930);
	});
});

describe('blockOf', () => {
	it('finds the block of a track id in each known catalogue', () => {
		expect(blockOf(3542154)).toBe(3542154);
		expect(blockOf(12072916 + 14)).toBe(12072916);
		expect(blockOf(3219045)).toBe(3219038);
	});

	it('knows no block for ids outside every catalogue', () => {
		expect(blockOf(3219037)).toBeUndefined();
		expect(blockOf(3219038 + 15)).toBeUndefined();
		expect(blockOf(undefined)).toBeUndefined();
	});
});

describe('trackIdInBlock', () => {
	it('numbers the sounds from the start of the block', () => {
		expect(trackIdInBlock('heartbeat', 3219038)).toBe(3219045);
		expect(trackIdInBlock('baa_baa_black_sheep', 3542154)).toBe(3542154);
	});

	it('knows no id for an unknown sound', () => {
		expect(trackIdInBlock('nope', 3219038)).toBeUndefined();
	});
});
