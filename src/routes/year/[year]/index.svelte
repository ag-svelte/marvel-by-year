<script context="module" lang="ts">
	import { browser } from '$app/env';

	// https://italonascimento.github.io/applying-a-timeout-to-your-promises/
	const promiseTimeout = function (ms: number, promise) {
		// Create a promise that rejects in <ms> milliseconds
		let timeout = new Promise((_, reject) => {
			let id = setTimeout(() => {
				clearTimeout(id);
				reject('Timed out in ' + ms + 'ms.');
			}, ms);
		});

		// Returns a race between our timeout and the passed in promise
		return Promise.race([promise, timeout]);
	};

	const DEFAULT_TIMEOUT = 9000;

	/**
	 * @type {import('@sveltejs/kit').Load}
	 */
	export async function load({ page, fetch }) {
		const url = `/year/${page.params.year}.json`;
		// Netlify functions have a execution time limit of 10 seconds
		// The Marvel API can be slow and take 20+ seconds in some cases
		// If we don't hear back in time, throw an error so the user can easily retry
		// Only do this on server render so the user sees a useful error page
		// In the browser, we don't want to fail too early.
		try {
			const apiCall = fetch(url, { credentials: 'omit' });
			const res = browser ? await apiCall : await promiseTimeout(DEFAULT_TIMEOUT, apiCall);
			const response: ComicResponse = await res.json();

			if (res.ok) {
				return {
					props: {
						response,
						year: parseInt(page.params.year)
					},
					maxage: 86400
				};
			}

			return {
				status: res.status,
				error: new Error(`Could not load ${url}`)
			};
		} catch (e) {
			console.log(page.params.year, e);
			return {
				status: 500,
				error: e
			};
		}
	}
</script>

<script lang="ts">
	import type { ComicResponse, Comic } from '$lib/types';
	import ComicSummary from '$lib/components/ComicSummary.svelte';
	import Filter from '$lib/components/Filter.svelte';
	import PageLinks from '$lib/components/PageLinks.svelte';
	import ComicGrid from '$lib/components/ComicGrid.svelte';
	import Select from '$lib/components/form/Select.svelte';
	import { createSelectedStores } from '$lib/stores/selected';
	import titleStore from '$lib/stores/title';
	import {
		getSeries,
		getCreators,
		getEvents,
		compareDates,
		compareTitles,
		isEventSelected,
		isCreatorSelected,
		compareUnlimitedDates,
		getOnSaleDate
	} from '$lib/comics';
	import { matchSorter } from 'match-sorter';
	import type { MatchSorterOptions } from 'match-sorter';
	import { page } from '$app/stores';

	export let response: ComicResponse;
	export let year: number;

	let search = $page.query.get('search') || '';

	enum SortOption {
		BestMatch = 'best match',
		Title = 'title',
		PublishDate = 'publish date',
		UnlimitedDate = 'unlimited date'
	}

	const sortingOptions = Object.values(SortOption);

	const months = [
		'all',
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];

	let startMonth = $page.query.get('month');
	let month = months[startMonth ? startMonth : 0];
	$: monthIndex = months.indexOf(month) - 1;

	let sortBy = SortOption.BestMatch;
	let searchText = search;
	let timer: ReturnType<typeof setTimeout>;
	let sortDescending = true;

	function updateSearchText(e: Event) {
		clearTimeout(timer);
		timer = setTimeout(() => {
			searchText = (e.target as HTMLInputElement).value;
		}, 250);
	}

	$: comics = response.comics;
	$: title = `Comics for ${monthIndex >= 0 ? month : ''} ${year}`;
	$: $titleStore = title;

	let [series, selectedSeries] = createSelectedStores(getSeries);
	$: series.applyNewComics(comics);

	let [creators, selectedCreators] = createSelectedStores(getCreators);
	$: creators.applyNewComics(comics);

	let [events, selectedEvents] = createSelectedStores(getEvents);
	$: events.applyNewComics(comics);

	// TODO: can this be more efficient?
	// with simulated CPU slowdown, there's lag when clearing the text field
	$: filteredComics = filterComics(
		comics,
		$selectedSeries,
		$selectedCreators,
		$selectedEvents,
		monthIndex
	);

	$: sortedComics = sortComics(filteredComics, sortBy, searchText);

	$: orderedComics = sortDescending ? sortedComics : [...sortedComics].reverse();

	function filterComics(
		comics: Comic[],
		selectedSeries: Set<string>,
		selectedCreators: Set<string>,
		selectedEvents: Set<string>,
		monthIndex: number
	) {
		let noCreatorsSelected = selectedCreators.size === $creators.size;
		let noEventsSelected = selectedEvents.size === $events.size;
		let noSeriesSelected = selectedSeries.size === $series.size;
		return comics.filter(
			(c) =>
				(monthIndex < 0 || getOnSaleDate(c).month() == monthIndex) &&
				(noSeriesSelected || selectedSeries.has(c.series.name)) &&
				(noCreatorsSelected || isCreatorSelected(c, selectedCreators)) &&
				(noEventsSelected || isEventSelected(c, selectedEvents))
		);
	}

	function sortComics(comics: Comic[], sortBy: string, searchText: string) {
		let sortFunction: MatchSorterOptions<Comic>['sorter'];

		switch (sortBy) {
			case SortOption.PublishDate:
				sortFunction = (matchItems) => matchItems.sort((a, b) => compareDates(a.item, b.item));
				break;
			case SortOption.Title:
				sortFunction = (matchItems) => matchItems.sort((a, b) => compareTitles(a.item, b.item));
				break;
			case SortOption.UnlimitedDate:
				sortFunction = (matchItems) =>
					matchItems.sort((a, b) => compareUnlimitedDates(a.item, b.item));
				break;
		}

		const matchedComics = matchSorter(comics, searchText, {
			keys: ['title'],
			// baseSort tie-breaks items that have the same ranking
			// when there's no search text (i.e. all items have same ranking), sort by date
			baseSort: searchText
				? (a, b) => compareTitles(a.item, b.item)
				: (a, b) => compareDates(a.item, b.item),
			// sorter sorts the items after matching them
			// using a custom function here means the items are sorted by something other than rank
			sorter: sortFunction
		});
		return matchedComics;
	}

	function resetFilters() {
		$selectedCreators = new Set($creators);
		$selectedSeries = new Set($series);
		$selectedEvents = new Set($events);
		searchText = '';
		month = months[0];
	}
</script>

<h1>{title}</h1>
<PageLinks {year} />

<p>
	Displaying {comics.length} comics
</p>
<p>
	(Filtered: {sortedComics.length} / {comics.length})
	<button on:click={resetFilters}>Reset filters</button>
</p>

<div class="search">
	<div>
		<label
			>Search <input
				type="text"
				autocomplete="off"
				autocorrect="off"
				autocapitalize="off"
				spellcheck="false"
				value={searchText}
				on:input={updateSearchText}
			/></label
		>
	</div>
	<div>
		<Select options={sortingOptions} id="sorting" bind:value={sortBy}>Sort by</Select>
	</div>
	<div>
		<Select options={months} id="month" bind:value={month}>Release Month</Select>
	</div>
	<div>
		<label><input type="checkbox" bind:checked={sortDescending} />Descending</label>
	</div>
</div>

<details>
	<summary>Filter</summary>
	<div class="filters">
		<Filter items={$series} legend="Series" included={selectedSeries} />
		<Filter items={$creators} legend="Creators" included={selectedCreators} />
		<Filter items={$events} legend="Events" included={selectedEvents} />
	</div>
</details>

<ComicGrid oneColOnMobile={true}>
	{#each orderedComics as comic, idx (comic.id)}
		<li>
			<ComicSummary
				{comic}
				lazyLoad={idx > 10}
				showUnlimitedDate={sortBy === SortOption.UnlimitedDate}
			/>
		</li>
	{:else}
		<li>Nothing to show!</li>
	{/each}
</ComicGrid>
<PageLinks {year} />

{#if response.attr}
	<p>{response.attr}</p>
{/if}

<style>
	.filters {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 0.5rem;
	}

	.search {
		margin: 0.5rem 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex-wrap: wrap;
		align-items: baseline;
	}

	input[type='checkbox'] {
		height: 1rem;
		width: 1rem;
		margin-right: 0.25rem;
	}

	summary {
		padding: 0.5rem;
	}

	@media screen and (min-width: 450px) {
		.search {
			flex-direction: row;
		}
	}
</style>
