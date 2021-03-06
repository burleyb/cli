"use strict";
const leo = require("leo-sdk");
exports.handler = require("leo-sdk/wrappers/cron.js")(function(event, context, callback) {
	let settings = Object.assign({}, event);
	leo.enrich({
		id: event.botId,
		inQueue: event.source,
		outQueue: event.destination,
		each: (payload, meta, done) => {
			// Enrich the event
			done(null, Object.assign({
				enriched: true,
				enrichedNow: Date.now()
			}, payload));
		}
	}, (err) => {
		console.log("All done processing events", err);
		callback(err);
	});
});
