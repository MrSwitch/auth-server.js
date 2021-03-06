'use strict';
var debug = require('debug')('login');

// login
// Expose the login page for session management

var db = require('../api/db');
var qs = require('querystring');
var crypt = require('./lib/crypt');

// Export this module as middleware
var app = module.exports = require('express')();

// Jade
app.set('view engine', 'pug');
app.set('views', __dirname + '/views');

// OAuth-Shim
// Configure OAuth-Shim with the credentials to use.
var creds = require('./credentials.js').credentials;
const REDIRECT_URI = require('./credentials.js').redirect_uri;

// Build URL's for the credentials
creds.forEach(cred => {

	// Pass some basic information back to the OAuthShim
	cred.state = cred.name;

	// Create url...
	cred.url = cred.auth + '&' + qs.stringify({
		client_id: cred.client_id,
		redirect_uri: REDIRECT_URI,
		response_type: 'code',
		state: cred.state
	});
});


// Continue...
// White list an outbound access_token...
app.use((req, res, next) => {

	// Whitelist a granted application?
	// Read the access_token to add the application to the list of approved_apps.
	// This is used internally to handle a successful login.
	if (req.query.access_token && req.query.redirect_uri) {
		// Decode the access_token
		let json = crypt.decrypt(req.query.access_token);

		if (json.user_id && json.client_id) {
			// Get the users approved app list to add to it...
			db('users')
			.get(['approved_apps'], {id: json.user_id})
			.then(data => {
				if (data.approved_apps.split(',').indexOf(json.client_id) === -1) {
					data.approved_apps += ',' + json.client_id;
					return db('users').update(data, {id: json.user_id});
				}
			});

			// forward the user on to their redirect_uri
			let redirect_uri = req.query.redirect_uri;
			delete req.query.redirect_uri;
			res.redirect(redirect_uri + '?' + qs.stringify(req.query));
		}
		else {
			res.render('error', {
				message: 'The access_token is not valid'
			});
		}

		// Do not continue
		return;
	}
	next();
});


// Check the redirect_uri matches client_id
app.use((req, res, next) => {

	// Check that all the information is given, redirect_uri, redirect_uri, etc...
	if (!req.query.client_id || !req.query.redirect_uri) {
		res.render('error', {
			message: 'client_id and or redirect_uri need to be provided'
		});
		return;
	}

	// Query the database for the redirect_uri which matches this database.
	db('client_apps')
	.get(['client_id, redirect_uri'], {client_id: req.query.client_id})
	.then(data => {

		// Test that the redirect_uri exists within the response
		if (match_redirect(data.redirect_uri, req.query.redirect_uri)) {
			// All good...
			next();
		}
		else {
			res.render('error', {
				message: 'The redirect_uri does not match that on record.'
			});
		}
	}, err => {
		res.render('error', err);
	});
});


// Bind handler to this
app.use((req, res, next) => {
	// Store the Request in the session for redirecting too this page after affiliate login.
	req.session.authRequest = req.url;

	// Default chain
	let chain = Promise.resolve(null);
	let userId = req.session ? req.session.user_id : undefined;
	let clientId = req.query.client_id;

	// Debug
	debug('Building login page');

	// Get the current connections for this user allocated
	if (userId) {
		chain = getUser(userId);
	}

	// Send back to the system
	chain.then(user => {

		debug('Render login page for', userId);

		// AuthResponse
		if (user && clientId) {
			var authResponse = getAuthResponse(userId, clientId);
			authResponse.state = req.query.state;
			authResponse = qs.stringify(authResponse);
		}

		// Redirect back to the redirect_uri with auth response
		// Unless the force=true in the query
		if (authResponse && user && user.approved_apps.indexOf(clientId) >= 0 && req.query.force !== 'true') {
			// Authenticated
			debug('redirect re-authenticated', req.query.redirect_uri);
			res.redirect(req.query.redirect_uri + '?' + authResponse);
			return;
		}
		// Refreshing the page with silent Authentication
		else if (req.query.display === 'none') {
			// Unauthenticated
			debug('redirect un-authenticated', req.query.redirect_uri);
			res.redirect(req.query.redirect_uri + '?' + qs.stringify({error: 'unauthenticated', error_message: 'Unable to refresh the users session'}));
			return;
		}

		// Render the login page
		res.render('login', {
			credentials: creds,
			user: user,
			query: req.query,
			auth_response: authResponse
		});
	}).then(null, err => {

		debug(err);
		next();

		res.end();
	});
});

// Debug
debug('auth/login ready');

// Get User Connections
function getUser(userId) {

	debug('Read user profile', userId);

	return db('users')
	.get(['*'], {id: userId})
	.then(user => {

		debug('Acquired user data');

		// Ensure we got a response
		if (user) {

			// Format the list of user approved apps from a string to an array
			user.approved_apps = (user.approved_apps || '').split(',');

			// Transpile user data
			user.connections = {};

			for (let x in user) {

				// Is this a connection entry?
				// There will be two properties, network'_id' and network'_profile'
				if (x.match(/_profile$/)) {
					let network = x.match(/^[^_]+/)[0];
					user.connections[network] = JSON.parse(user[x]);
				}
			}
		}

		return user;
	});
}

function getAuthResponse(user_id, client_id) {
	// authResponse
	let authResponse = {
		expires_in: 3600
	};

	// Generate an AuthResponse for this user...
	authResponse.access_token = crypt.encrypt({
		expires: Date.now() + (authResponse.expires_in * 1000),
		user_id: user_id,
		client_id: client_id
	});

	return authResponse;
}

function match_redirect(match, path) {
	let a = match.split(/[\,\s]+/);
	for (let i = 0; i < a.length; i++) {
		let cond = a[i];
		if (path.indexOf(cond) > -1) {
			return true;
		}
	}
	return false;
}
