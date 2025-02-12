import md5 from 'crypto-js/md5.js';
import type { ComicDataWrapper } from '$lib/types/marvel';
import type { RandomComic } from '$lib/types';
import type RedisClient from '$lib/redis';
import { dedupe } from '$lib/util';
import { performance } from 'perf_hooks';

const PUBLIC_KEY = process.env['MARVEL_PUBLIC_KEY'];
const PRIVATE_KEY = process.env['MARVEL_PRIVATE_KEY'];

const COMICS_ENDPOINT = 'https://gateway.marvel.com/v1/public/comics';
const MAX_LIMIT = 100;

export default class MarvelApi {
	redis: RedisClient;
	ignoreCache: boolean;
	constructor(redis: RedisClient, ignoreCache: boolean = false) {
		this.redis = redis;
		this.ignoreCache = ignoreCache;
	}

	async getComics(
		year: number,
		page: number,
		cache: Record<number, ComicDataWrapper>,
		comicIdsWithImages: Set<string>
	): Promise<ComicDataWrapper> {
		console.log(`retrieving ${year} page ${page}`);

		let start = performance.now();
		if (cache[page]) {
			console.log(`found ${year} page ${page} in redis cache`);
			return cache[page];
		}

		const result = await this.callMarvelApi(
			COMICS_ENDPOINT,
			getComicsSearchParams(year, page * MAX_LIMIT, MAX_LIMIT)
		);

		console.log('called Marvel API in', (performance.now() - start) / 1000);
		start = performance.now();

		const parsedResult: ComicDataWrapper = await result.json();
		if (parsedResult.code === 200) {
			await this.redis.addComics(year, page, parsedResult, comicIdsWithImages);
		}
		console.log('updated redis in', (performance.now() - start) / 1000);

		return parsedResult;
	}

	async getTotalComics(year: number): Promise<number> {
		const key = `year:${year}:total`;
		const val = await this.redis.get<number>(key, parseInt);
		if (val && !this.ignoreCache) {
			return val;
		}

		const result = await this.callMarvelApi(COMICS_ENDPOINT, getComicsSearchParams(year, 0, 1));
		const parsedResult: ComicDataWrapper = await result.json();

		if (parsedResult.code === 200) {
			const { total } = parsedResult.data;
			await this.redis.set(key, total);
			return total;
		}
		return -1;
	}

	async getRandomComics(startYear?: number, endYear?: number): Promise<RandomComic[]> {
		if (startYear && endYear) {
			const seed = Date.now();
			const result = await this.redis.getRandomComicsForYear(startYear, endYear, seed);
			return dedupe(result, (x) => x.id);
		}
		return await this.redis.getRandomComics();
	}

	async callMarvelApi(urlString: string, params: Record<string, string>): Promise<Response> {
		const ts = Date.now().toString();

		const paramsWithKey = {
			...params,
			apikey: PUBLIC_KEY,
			hash: md5(ts + PRIVATE_KEY + PUBLIC_KEY).toString(),
			ts
		};

		const url = new URL(urlString);
		url.search = new URLSearchParams(paramsWithKey).toString();

		return await fetch(url.toString());
	}
}

function getComicsSearchParams(year: number, offset: number, limit: number) {
	return {
		formatType: 'comic',
		noVariants: 'true',
		dateRange: `${year}-01-01,${year}-12-31`,
		hasDigitalIssue: 'true',
		limit: limit.toString(),
		offset: offset.toString(),
		// when ordering by other fields (e.g. date), the API response is missing some comics. So don't change this without testing!
		// to check if comics are missing, order a year alphabetically and check for missing issue numbers
		// if duplicates are found, this likely means another comic is missing.
		orderBy: 'modified'
	};
}
