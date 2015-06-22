define( function( require ) {

	"use strict";

	var $ = require( 'jquery' );
	var _ = require( 'underscore' );
	var Backbone = require( 'backbone' );
	var App = require( 'core/app' );
	var Hooks = require( 'core/lib/hooks' );
	var Config = require( 'root/config' );
	var Sha256 = require( 'core/lib/encryption/sha256' );
	var WsToken = require( 'core/lib/encryption/token' );
	var LocalStorage = require( 'core/modules/persistent-storage' );
	require( 'core/lib/encryption/jsencrypt' );
	
	require( 'localstorage' );

	var AuthenticationDataModel = Backbone.Model.extend( {
		localStorage: new Backbone.LocalStorage( 'Authentication' ),
		defaults: {
			user_login: "",
			secret: "",
			public_key: "",
			is_authenticated : false,
			scope: {}
		}
	} );

	var authenticationData = new AuthenticationDataModel();
	authenticationData.fetch();
	
	var ws_url = WsToken.getWebServiceUrlToken( 'authentication' ) + '/authentication/';

	var authentication = { };

	var generateRandomSecret = function() {
		var base = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890-=!@#$%^&*()_+:<>{}[]".split( '' );
		var secret = '';
		for ( var i = 0; i < 50; i++ ) {
			secret += base[Math.floor( Math.random() * base.length )];
		}
		return secret;
	};

	var generateHMAC = function( data, secret ) {
		if ( secret !== undefined ) {
			data = data + '|' + secret;
		}
		return Sha256( data );
	};
	
	var getTimestamp = function() {
		return Math.floor( Date.now() / 1000);
	};
	
	/**
	 * Builds the HMAC secured Web service params object.
	 * 
	 * @param string auth_action
	 * @param string user
	 * @param boolean use_user_control Whether to use the user secret key or generate a random one
	 * @param array data_keys Sets the order of data items for hmac
	 * @param object data Data to send to server
	 * @returns object HMAC secured Web service params object
	 */
	var getAuthWebServicesParams = function( auth_action, user, use_user_control, data_keys, data ) {
		
		user = user === undefined ? 'wpak-app' : user;
		
		var timestamp = getTimestamp();

		var web_service_params = {
			auth_action: auth_action,
			user: user,
			timestamp: timestamp,
		};
		
		var control_key = '';
		if ( use_user_control === undefined || use_user_control === false ) {
			//Used when the user secret key is not defined yet : generate random temporary secret
			//and send it along with web service params.
			control_key = generateRandomSecret();
			web_service_params.control_key = control_key;
		} else {
			//User secret key is available : we use it for HMAC, but we DON'T send
			//it as a web service param!
			control_key = authenticationData.get( 'secret' );
		}

		var to_control = [auth_action, user, timestamp];
		if ( data_keys !== undefined && data !== undefined ) {
			_.each( data_keys, function( value ) {
				to_control.push( data[value] );
				web_service_params[value] = data[value];
			} );
		}
		
		var control_string = '';
		_.each( to_control, function( value ) {
			control_string += value;
		} );
		
		web_service_params.control = generateHMAC( control_string, control_key )
		
		return web_service_params;
	};

	var ajaxQuery = function( web_service_params, success, error ) {
		
		/**
		* Filter 'web-service-params' : use this to send custom key/value formated  
		* data along with the web service. Those params are passed to the server 
		* (via $_GET) when calling the web service.
		* 
		* Filtered data : web_service_params : JSON object where you can add your custom web service params
		* Filter arguments : 
		* - web_service_name : string : name of the current web service ('synchronization' here).
		*/
		web_service_params = Hooks.applyFilters( 'web-service-params', web_service_params, [ 'authentication' ] );

		//Build the ajax query :
		var ajax_args = {
			timeout: 40000,
			data: web_service_params
		};

		/**
		 * Filter 'ajax-args' : allows to customize the web service jQuery ajax call.
		 * Any jQuery.ajax() arg can be passed here except for : 'url', 'type', 'dataType', 
		 * 'success' and 'error' that are reserved by app core.
		 * 
		 * Filtered data : ajax_args : JSON object containing jQuery.ajax() arguments.
		 * Filter arguments : 
		 * - web_service_name : string : name of the current web service ('synchronization' here).
		 */
		ajax_args = Hooks.applyFilters( 'ajax-args', ajax_args, [ 'authentication' ] );

		ajax_args.url = Config.wp_ws_url + ws_url;

		ajax_args.type = 'GET';

		ajax_args.dataType = 'json';
		
		ajax_args.success = success;
		
		ajax_args.error = error;
		
		console.log( 'Sending auth query', ajax_args );
		
		$.ajax( ajax_args );
	};

	var getPublicKey = function( user, cb_ok, cb_error ) {

		console.log( 'Get public key for', user );

		var web_service_params = getAuthWebServicesParams( 'get_public_key', user, false );

		//Retrieve app's public key from server :
		var success = function( data ) {
			console.log( 'Public key returned', data );
			if ( data.hasOwnProperty( 'result' ) && data.result.hasOwnProperty( 'status' ) ) {
				if ( data.result.status == 1 ) {
					if ( data.public_key && data.public_key.length ) {
						
						//TODO : do a HMAC check here
						
						//Save public key to Local Storage :
						authenticationData.set( 'public_key', data.public_key );
						
						cb_ok();
						
					} else {
						cb_error();
					}
				} else {
					cb_error();
				}
			}
		};

		var error = function( jqXHR, textStatus, errorThrown ) {
			App.triggerError(
				'synchro:ajax',
				{ type: 'ajax', where: 'authentication::getPublicKey', message: textStatus + ': ' + errorThrown, data: { url: Config.wp_ws_url + ws_url, jqXHR: jqXHR, textStatus: textStatus, errorThrown: errorThrown } },
				cb_error
			);
		};

		ajaxQuery( web_service_params, success, error );
		
	};
	
	var sendAuthData = function( user, pass, cb_ok, cb_error ) {
		
		console.log( 'Send auth data' );
		
		//Get public key from Local Storage :
		var public_key = authenticationData.get( 'public_key' );
		if ( public_key.length ) {
			
			//Generate local app user secret key (for symetric encryption):
			var user_secret = generateRandomSecret();

			//Store it in local storage :
			authenticationData.set( 'secret', user_secret );
			authenticationData.save();
			
			var encrypt = new JSEncrypt();
			encrypt.setPublicKey( public_key );
			
			var to_encrypt = {
				user : user,
				pass : pass,
				secret : user_secret
			};
			
			var encrypted = encrypt.encrypt( JSON.stringify( to_encrypt ) );
			
			var web_service_params = getAuthWebServicesParams( 'connect_user', user, true, ['encrypted'], { encrypted: encrypted } );

			var success = function( data ) {
				console.log( 'Authentication result', data );
				if ( data.hasOwnProperty( 'result' ) && data.result.hasOwnProperty( 'status' ) ) {
					if ( data.result.status == 1 ) {
						if ( data.auth_result ) {
							
							
							
							cb_ok( data.auth_result );
						} else {
							cb_error();
						}
					} else {
						cb_error();
					}
				}
			};

			var error = function( jqXHR, textStatus, errorThrown ) {
				App.triggerError(
					'synchro:ajax',
					{ type: 'ajax', where: 'authentication::sendAuthData', message: textStatus + ': ' + errorThrown, data: { url: Config.wp_ws_url + ws_url, jqXHR: jqXHR, textStatus: textStatus, errorThrown: errorThrown } },
					cb_error
				);
			};
		
			ajaxQuery( web_service_params, success, error );
			
		} else {
			
			cb_error();
			
		}
		
	};

	authentication.getCurrentSecret = function() {
		var current_secret = authenticationData.get( 'secret' );
		return current_secret;
	};

	authentication.resetSecret = function() {
		var new_secret = generateRandomSecret();
		authenticationData.set( 'secret', new_secret );
		authenticationData.save();
	};

	authentication.getCurrentUser = function() {
		var user = authenticationData.get( 'user_login' );
		if ( !user.length ) {
			
		}
	};
	
	authentication.currentUserIsAuthenticated = function() {
		return authenticationData.get( 'is_authenticated' );
	};
	
	authentication.checkUserAuthenticationFromRemote = function() {
		//Check that the user connection is still valid.
		//Recheck public key and user secret from server
	}
	
	authentication.connectUser = function( login, pass ) {
		getPublicKey( 
			login, 
			function( public_key ) {
				sendAuthData( 
					login, 
					pass,
					function() {
						
					},
					function() {
						
					}
				);
			}, 
			function() {
				 
			}
		);
	}

	authentication.init = function() {
		authentication.connectUser( 'admin', 'passadmin' );
	};

	return authentication;
} );