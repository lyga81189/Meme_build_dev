/* ByteBrewSDK.js — WebGL adapter (khớp .jslib của bạn)
 * KHÔNG import/export; KHÔNG type="module"
 */
(function (w) {
    // ================= Helpers =================
    function uuidv4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0,
                v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    const Cookies = {
        set: function (name, value, opts) {
            opts = opts || {};
            const d = new Date();
            const days = opts.expires || 365;
            d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
            document.cookie =
                encodeURIComponent(name) +
                '=' +
                encodeURIComponent(value) +
                '; expires=' +
                d.toUTCString() +
                '; path=/';
        },
        get: function (name) {
            const v = ('; ' + document.cookie).split('; ' + encodeURIComponent(name) + '=');
            if (v.length === 2) return decodeURIComponent(v.pop().split(';').shift());
            return null;
        },
        remove: function (name) {
            document.cookie = encodeURIComponent(name) + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
        }
    };

    // ================= Constants (lấy từ .jspre bạn gửi) =================
    const LOGS_URL = 'https://web-platform.bytebrew.io/api/game/logs/add';
    const REMOTE_URL_BASE = 'https://web-platform.bytebrew.io/api/game/configurations/remote/'; // + appId
    const SESSION_KEY_HEADER = 'session_key';
    const SDK_VERSION = 'bytebrew-web-sdk 1.0.2'; // chuỗi thấy trong .jspre
    const PLATFORM = 'Web';

    // ================= Public namespace expected by .jslib =================
    w.ByteBrewSDK = w.ByteBrewSDK || {};
    w.ByteBrewSDK.ByteBrew = (function () {
        // ---- internal state ----
        const USER_ID_COOKIE = 'bb_u_id';                  // từ .jspre
        const TRACKING_COOKIE = 'bb_tr_on';                // ENABLED/DISABLED
        const INIT_OK_COOKIE = 'bb_u_h_init';              // userHasInitializedSuccessfullyCookieKey

        let appId = '';
        let appKey = '';
        let appVersion = '';
        let userID = '';
        let sessionID = '';
        let sessionKey = '';
        let initialized = false;
        let trackingEnabled = true;
        let hasBeenInitializedWhilePageOpen = false;
        let sessionStartTime = null;

        let remoteConfigs = null; // Map<string,string> | null

        const language = (navigator.language || '').toString();
        function getCountryCode() {
            const parts = (navigator.language || '').split('-');
            if (parts.length < 2) return '??';
            const c = parts[parts.length - 1];
            return c || '??';
        }
        const country = getCountryCode();

        function tryGetUserIDFromCookie() {
            const fromCookie = Cookies.get(USER_ID_COOKIE);
            if (fromCookie) {
                return { userID: fromCookie, isNewUser: false, hasSuccessfullyInitialized: Cookies.get(INIT_OK_COOKIE) === fromCookie };
            }
            const id = uuidv4();
            Cookies.set(USER_ID_COOKIE, id, { expires: 365 });
            return { userID: id, isNewUser: true, hasSuccessfullyInitialized: false };
        }

        function setTrackingSettingsCookie(enabled) {
            Cookies.set(TRACKING_COOKIE, enabled ? 'true' : 'false', { expires: 365 });
        }
        function getTrackingSettingsCookie() {
            const v = Cookies.get(TRACKING_COOKIE);
            return !v || v === 'true';
        }
        function setUserHasInitializedSuccessfullyCookie() {
            if (userID) Cookies.set(INIT_OK_COOKIE, userID, { expires: 365 });
        }

        function getScreenResolution() {
            return window.innerWidth + 'x' + window.innerHeight;
        }

        function canSendData() {
            return initialized && trackingEnabled;
        }

        function baseEvent() {
            return {
                game_id: appId,
                user_id: userID,
                session_id: sessionID,
                session_key: sessionKey,
                platform: PLATFORM
            };
        }

        function fullEvent() {
            return Object.assign({}, baseEvent(), {
                version_number: appVersion,
                sdk_version: SDK_VERSION,
                deviceScreenSize: getScreenResolution(),
                tracking_enabled: trackingEnabled
            });
        }

        // ---- web requestor (khớp .jspre) ----
        function sendRequest(url, bodyObj) {
            const opt = {
                method: 'POST',
                mode: 'cors',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json;charset=UTF-8',
                    'sdk-key': appKey
                },
                body: JSON.stringify(bodyObj),
                keepalive: true
            };
            return fetch(url, opt);
        }

        function sendRemoteConfigRequest(url) {
            const opt = {
                method: 'GET',
                mode: 'cors',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json;charset=UTF-8',
                    'sdk-key': appKey,
                    'user_id': userID
                }
            };
            return fetch(url, opt);
        }

        // ================= Public API (MUST match .jslib names) =================
        function initializeByteBrew(_appId, _appKey, _appVersion) {
            console.log('ByteBrew: Starting Initialization');
            if (initialized) return;

            if (!_appId || !_appKey) {
                console.error('ByteBrew: Initialization Failed. Please provide all the required parameters.');
                return;
            }

            trackingEnabled = getTrackingSettingsCookie();
            if (!trackingEnabled) {
                console.log('ByteBrew: Tracking is disabled. Not initializing.');
                return;
            }

            const info = tryGetUserIDFromCookie();
            userID = info.userID;

            appId = _appId;
            appKey = _appKey;
            appVersion = _appVersion || '';
            sessionID = uuidv4();
            sessionKey = '';
            sessionStartTime = new Date();
            hasBeenInitializedWhilePageOpen = true;

            // User event: new/existing
            const isNewUser = info.isNewUser || !info.hasSuccessfullyInitialized;
            const externalData = {
                eventType: isNewUser ? 'new_user' : 'game_open',
                userLocale: language
            };
            const payload = Object.assign({}, fullEvent(), {
                category: 'user',
                geo: country,
                externalData
            });

            // Gửi init → đọc session_key ở header
            sendRequest(LOGS_URL, payload)
                .then(res => {
                    if (res && res.ok) {
                        const sk = res.headers.get(SESSION_KEY_HEADER);
                        if (sk) {
                            sessionKey = sk;
                            initialized = true;
                            setUserHasInitializedSuccessfullyCookie();
                            console.log('ByteBrew: Initialization Complete');
                            // lắng nghe end session
                            window.addEventListener('beforeunload', endCurrentSession);
                        } else {
                            console.log("ByteBrew: Initialization Failed! Couldn't get session key from ByteBrew: Status " + (res ? res.status : 'No Response'));
                        }
                    } else {
                        console.log("ByteBrew: Initialization Failed! Couldn't get session key from ByteBrew: Status " + (res ? res.status : 'No Response'));
                    }
                })
                .catch(err => console.error(err));
        }

        function reinitializeByteBrew() {
            console.log('ByteBrew: Reinitalizing ByteBrew');
            initializeByteBrew(appId, appKey, appVersion);
        }

        function onInitializationSuccessful() {
            // .jspre có dùng gọi lại nếu cần; ở đây giữ cho đủ API
            if (hasBeenInitializedWhilePageOpen) {
                console.log('ByteBrew: Restarting after successful init while page open');
                reinitializeByteBrew();
            }
        }

        function isByteBrewInitialized() {
            return initialized && trackingEnabled;
        }

        function endCurrentSession() {
            if (!(initialized && getTrackingSettingsCookie())) return;
            initialized = false;
            console.log('ByteBrew: Ending Current Session');

            const now = new Date();
            const secs = Math.max(0, Math.round((now.getTime() - (sessionStartTime ? sessionStartTime.getTime() : now.getTime())) / 1000));
            const payload = Object.assign({}, fullEvent(), {
                category: 'session',
                externalData: { sessionLength: String(secs) }
            });
            // fire-and-forget
            sendRequest(LOGS_URL, payload).catch(console.error);
        }

        function sendCustomEvent(eventName, value) {
            if (!canSendData()) return;
            console.log('ByteBrew: Sending Custom Event: ' + eventName);

            let externalData = { eventType: eventName };
            if (typeof value !== 'undefined') {
                externalData.value = (typeof value === 'object') ? JSON.stringify(value) : String(value);
            }

            const payload = Object.assign({}, fullEvent(), {
                category: 'custom',
                externalData
            });

            sendRequest(LOGS_URL, payload).then(res => {
                if (res && res.ok) console.log('ByteBrew: Custom Event Sent Successfully');
                else console.log('ByteBrew: Custom Event Failed to Send: Status ' + (res ? res.status : 'No Response'));
            }).catch(console.error);
        }

        function loadRemoteConfigs(onLoaded) {
            const url = REMOTE_URL_BASE + appId;
            sendRemoteConfigRequest(url).then(res => {
                if (res && res.ok) {
                    return res.text().then(t => {
                        try {
                            const obj = JSON.parse(t); // server trả JSON object key->value
                            remoteConfigs = new Map(Object.entries(obj));
                            console.log('ByteBrew: Remote configurations retrieved');
                        } catch (e) {
                            remoteConfigs = null;
                            console.error('ByteBrew Exception: Failed to parse remote configs');
                        } finally {
                            if (remoteConfigs && typeof onLoaded === 'function') onLoaded(remoteConfigs);
                        }
                    });
                } else if (res) {
                    console.error('ByteBrew Exception: ' + (res ? res.status : 'No Response') + ' ' + (res ? res.statusText : ''));
                } else {
                    console.error('ByteBrew Exception: Failed to retrieve remote configs');
                }
            }).catch(err => console.error(err));
        }

        function retreiveRemoteConfigValue(key, defaultValue) {
            // Chính tả theo .jslib: "retreive"
            if (remoteConfigs && remoteConfigs.has(key)) return remoteConfigs.get(key);
            return defaultValue;
        }

        function hasRemoteConfigsBeenSet() {
            return !!remoteConfigs;
        }

        function restartTracking() {
            console.log('ByteBrew: Restarting Tracking');
            trackingEnabled = true;
            setTrackingSettingsCookie(true);
            reinitializeByteBrew();
        }

        function stopTracking() {
            console.log('ByteBrew: Stopping Tracking');
            trackingEnabled = false;
            setTrackingSettingsCookie(false);
        }

        // ================= expose EXACT API names for .jslib =================
        return {
            // fields .jslib có đọc:
            get appKey() { return appKey; },
            get userID() { return userID; },
            get platform() { return PLATFORM; },

            initializeByteBrew,
            isByteBrewInitialized,
            restartTracking,
            stopTracking,
            endCurrentSession,

            // events
            newCustomEvent: function (eventName) { sendCustomEvent(eventName); },
            newCustomEventWithString: function (eventName, value) { sendCustomEvent(eventName, value); },
            newCustomEventWithNumber: function (eventName, value) { sendCustomEvent(eventName, value); },
            newCustomEventWithJSONDictionary: function (eventName, jsonObj) { sendCustomEvent(eventName, jsonObj); },

            // remote config
            loadRemoteConfigs,
            retreiveRemoteConfigValue,
            hasRemoteConfigsBeenSet,

            // misc
            getUserID: function () { return String(userID || ''); }
        };
    })();
})(window);
