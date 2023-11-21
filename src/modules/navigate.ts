import type Swup from '../Swup.js';
import { createHistoryRecord, updateHistoryRecord, getCurrentUrl, Location } from '../helpers.js';
import { FetchError, type FetchOptions, type PageData } from './fetchPage.js';
import { type VisitInitOptions, type Visit, VisitState } from './Visit.js';

export type HistoryAction = 'push' | 'replace';
export type HistoryDirection = 'forwards' | 'backwards';
export type NavigationToSelfAction = 'scroll' | 'navigate';
export type CacheControl = Partial<{ read: boolean; write: boolean }>;

/** Define how to navigate to a page. */
type NavigationOptions = {
	/** Whether this visit is animated. Default: `true` */
	animate?: boolean;
	/** Name of a custom animation to run. */
	animation?: string;
	/** History action to perform: `push` for creating a new history entry, `replace` for replacing the current entry. Default: `push` */
	history?: HistoryAction;
	/** Whether this visit should read from or write to the cache. */
	cache?: CacheControl;
};

/**
 * Navigate to a new URL.
 * @param url The URL to navigate to.
 * @param options Options for how to perform this visit.
 * @returns Promise<void>
 */
export function navigate(
	this: Swup,
	url: string,
	options: NavigationOptions & FetchOptions = {},
	init: Omit<VisitInitOptions, 'to'> = {}
) {
	if (typeof url !== 'string') {
		throw new Error(`swup.navigate() requires a URL parameter`);
	}

	// Check if the visit should be ignored
	if (this.shouldIgnoreVisit(url, { el: init.el, event: init.event })) {
		window.location.href = url;
		return;
	}

	const { url: to, hash } = Location.fromUrl(url);

	const visit = this.createVisit({ ...init, to, hash });
	this.performNavigation(visit, options);
}

/**
 * Start a visit to a new URL.
 *
 * Internal method that assumes the visit context has already been created.
 *
 * As a user, you should call `swup.navigate(url)` instead.
 *
 * @param url The URL to navigate to.
 * @param options Options for how to perform this visit.
 * @returns Promise<void>
 */
export async function performNavigation(
	this: Swup,
	visit: Visit,
	options: NavigationOptions & FetchOptions = {}
): Promise<void> {
	if (this.navigating) {
		if (this.visit.state >= VisitState.ENTERING) {
			// Currently navigating and content already loaded? Finish and queue
			visit.state = VisitState.QUEUED;
			this.onVisitEnd = () => this.performNavigation(visit, options);
			return;
		} else {
			// Currently navigating and content not loaded? Abort running visit
			await this.hooks.call('visit:abort', this.visit, undefined);
			this.visit.state = VisitState.ABORTED;
		}
	}

	this.navigating = true;
	this.visit = visit;

	const { el } = visit.trigger;
	options.referrer = options.referrer || this.currentPageUrl;

	if (options.animate === false) {
		visit.animation.animate = false;
	}

	// Clean up old animation classes
	if (!visit.animation.animate) {
		this.classes.clear();
	}

	// Get history action from option or attribute on trigger element
	const history = options.history || el?.getAttribute('data-swup-history') || undefined;
	if (history && ['push', 'replace'].includes(history)) {
		visit.history.action = history as HistoryAction;
	}

	// Get custom animation name from option or attribute on trigger element
	const animation = options.animation || el?.getAttribute('data-swup-animation') || undefined;
	if (animation) {
		visit.animation.name = animation;
	}

	// Sanitize cache option
	if (typeof options.cache === 'object') {
		visit.cache.read = options.cache.read ?? visit.cache.read;
		visit.cache.write = options.cache.write ?? visit.cache.write;
	} else if (options.cache !== undefined) {
		visit.cache = { read: !!options.cache, write: !!options.cache };
	}
	// Delete this so that window.fetch doesn't mis-interpret it
	delete options.cache;

	try {
		await this.hooks.call('visit:start', visit, undefined);
		visit.state = VisitState.STARTED;

		// Begin loading page
		const pagePromise = this.hooks.call(
			'page:load',
			visit,
			{ options },
			async (visit, args) => {
				// Read from cache
				let cachedPage: PageData | undefined;
				if (visit.cache.read) {
					cachedPage = this.cache.get(visit.to.url);
				}

				args.page = cachedPage || (await this.fetchPage(visit.to.url, args.options));
				args.cache = !!cachedPage;

				return args.page;
			}
		);

		// Mark as loaded when finished
		pagePromise.then(() => visit.advance(VisitState.LOADED));

		// Create/update history record if this is not a popstate call or leads to the same URL
		if (!visit.history.popstate) {
			// Add the hash directly from the trigger element
			const newUrl = visit.to.url + visit.to.hash;
			if (visit.history.action === 'replace' || visit.to.url === this.currentPageUrl) {
				updateHistoryRecord(newUrl);
			} else {
				this.currentHistoryIndex++;
				createHistoryRecord(newUrl, { index: this.currentHistoryIndex });
			}
		}

		this.currentPageUrl = getCurrentUrl();

		// Wait for page before starting to animate out?
		if (visit.animation.wait) {
			const { html } = await pagePromise;
			visit.to.html = html;
		}

		// Check if aborted in the meantime
		if (visit.aborted) return;

		// perform the actual transition: animate and replace content
		await this.hooks.call('visit:transition', visit, undefined, async () => {
			// Start leave animation
			visit.advance(VisitState.LEAVING);
			const animationPromise = this.animatePageOut(visit);

			// Wait for page to load and leave animation to finish
			const [page] = await Promise.all([pagePromise, animationPromise]);

			// Render page: replace content and scroll to top/fragment
			await this.renderPage(visit, page);

			// Wait for enter animation
			visit.advance(VisitState.ENTERING);
			await this.animatePageIn(visit);

			return true;
		});

		// Finalize visit
		await this.hooks.call('visit:end', visit, undefined, () => this.classes.clear());
		visit.state = VisitState.COMPLETED;
		this.navigating = false;

		/** Run eventually queued function */
		if (this.onVisitEnd) {
			this.onVisitEnd();
			this.onVisitEnd = undefined;
		}
	} catch (error) {
		// Return early if error is undefined or signals an aborted request
		if (!error || (error as FetchError)?.aborted) {
			visit.state = VisitState.ABORTED;
			return;
		}

		visit.state = VisitState.FAILED;

		// Log to console as we swallow almost all hook errors
		console.error(error);

		// Rewrite `skipPopStateHandling` to redirect manually when `history.go` is processed
		this.options.skipPopStateHandling = () => {
			window.location.href = visit.to.url + visit.to.hash;
			return true;
		};

		// Go back to the actual page we're still at
		window.history.go(-1);
	}
}
