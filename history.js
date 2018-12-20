//  立刻执行函数是前端模块化的基石，通过IIEF方式可以最小程度减少库变量的全局污染
// 下面整个代码的功能就是为浏览器环境提供history API的支持，在实现过程中会检测浏览器是否原生支持history
// 如果不支持则经过polyfill方式实现一套，history的实现核心就是检测地址栏URL的变化并触发相关行为，而拦截浏览器默认的页面刷新动作
(function(factory) {
  // 基于浏览器运行环境的AMD模块化
  if (typeof define === "function" && define["amd"]) {

    // 如果引入了requireJS库
    if (typeof requirejs !== "undefined") {
      var r = requirejs,
        rndKey = "[history" + new Date().getTime() + "]";
      var onError = r["onError"];
      factory.toString = function() {
        return rndKey;
      };
      ["onError"] = function(err) {
        if (err.message.indexOf(rndKey) === -1) {
          onError.call(r, err);
        }
      };
    }

    // 基于AMD模块化的定义，history不依赖任何模块
    define([], factory);
  }

  //  针对CommonJS模块化的history版本，从而支持在Node环境使用
  if (typeof exports === "object" && typeof module !== "undefined") {
    module["exports"] = factory();
  } else {
    //  针对其他情况执行工厂函数
    return factory();
  }
})(function() {
  // global可以表示window对象也可以表示其他运行平台的上下文环境
  var global = (typeof window === "object" ? window : this) || {};

  // 如果宿主环境不支持history或者history库已经被加载，则直接返回
  if (!global.history || "emulate" in global.history) {
    return global.history;
  }

  
  var document = global.document;
  var documentElement = document.documentElement;
  var Object = global["Object"];
  var JSON = global["JSON"];

  // 宿主环境具有location全局属性
  var windowLocation = global.location;

  // 宿主环境具有history对象属性
  var windowHistory = global.history;
  var historyObject = windowHistory;

  // 下面表示符合W3C规范的history API集合
  // 注意history.pushState动作会增加新的记录条目到session history中
  // 而history.replaceState动作会替换当前URL下的记录条目的state对象，而不会新增记录
  var historyPushState = windowHistory.pushState;
  var historyReplaceState = windowHistory.replaceState;

  // 检查宿主环境是否原生支持history API
  var isSupportHistoryAPI = isSupportHistoryAPIDetect();

  // W3C规范中history对象具有state属性
  var isSupportStateObjectInHistory = "state" in windowHistory;
  var defineProperty = Object.defineProperty;
  // new instance of 'Location', for IE8 will use the element HTMLAnchorElement, instead of pure object
  var locationObject = redefineProperty({}, "t")
    ? {}
    : document.createElement("a");


  // 事件名称前缀
  var eventNamePrefix = "";
  // 针对不同宿主环境，绑定事件/解绑事件和分发事件的方法是不一样的
  var addEventListenerName = global.addEventListener
    ? "addEventListener"
    : (eventNamePrefix = "on") && "attachEvent";

  var removeEventListenerName = global.removeEventListener
    ? "removeEventListener"
    : "detachEvent";

  var dispatchEventName = global.dispatchEvent ? "dispatchEvent" : "fireEvent";

  var addEvent = maybeBindToGlobal(global[addEventListenerName]);
  var removeEvent = maybeBindToGlobal(global[removeEventListenerName]);
  var dispatch = maybeBindToGlobal(global[dispatchEventName]);
  
  
  // history对象的一些默认设置
  var settings = { basepath: "/", redirect: 0, type: "/", init: 0 };

  // sessionStorage在当前会话上下文有效
  var sessionStorageKey = "__historyAPI__";
  
  // 联想react-route中，Link组件其实就是基于a标签封装；
  // 浏览器对a标签的URL地址跳转，会触发地址栏URL的修改；然后再进行页面刷新动作
  // 那么引入history对象后，对地址栏的URL变化事件进行监听，并拦截了浏览器默认的页面刷新动作
  var anchorElement = document.createElement("a");
  
  // 在URL发生变化前的地址
  var lastURL = windowLocation.href;
  var checkUrlForPopState = "";
  var triggerEventsInWindowAttributes = 1;
  
  // 页面加载触发popstate事件
  var isFireInitialState = false;
 
  // 是否使用了history.location标志位
  var isUsedHistoryLocationFlag = 0;
  
  // 保存当前session的state记录，在浏览器当前Tab/Window下的所有浏览记录都在session空间下
  var stateStorage = {};

  // 保存事件处理函数
  var eventsList = {};
  
  // 保存上一个页面的title属性
  var lastTitle = document.title;
  
  // 保存自定义源
  var customOrigin;

  // 定义两个事件，其中URL的哈希变化并不会触发浏览器的页面刷新动作
  // 而onpopstate事件发生在浏览器针对同一个document对象的历史记录条目发生变化触发，这在SPA应用很常见
  var eventsDescriptors = {
    onhashchange: null,
    onpopstate: null
  };

  /**
   * Fix for Chrome in iOS
   * See https://github.com/devote/HTML5-History-API/issues/29
   */
  var fastFixChrome = function(method, args) {
    var isNeedFix = global.history !== windowHistory;
    if (isNeedFix) {
      global.history = windowHistory;
    }
    method.apply(windowHistory, args);
    if (isNeedFix) {
      global.history = historyObject;
    }
  };

// 定义history对象的属性，用于模拟原生的history API
  var historyDescriptors = {
  
    /**
     * 初始化history库
     * @param {*} basepath 站点基础路径，默认为“/”
     * @param {*} type a标签替换路径，默认为"/“
     * @param {*} redirect 链接的重定向
     */
    setup: function(basepath, type, redirect) {
      settings["basepath"] = (
        "" + (basepath == null ? settings["basepath"] : basepath)
      ).replace(/(?:^|\/)[^\/]*$/, "/");
      settings["type"] = type == null ? settings["type"] : type;
      settings["redirect"] =
        redirect == null ? settings["redirect"] : !!redirect;
    },
   
    /**
     * 
     * @param {*} type a 标签替换路径，默认为“/”
     * @param {*} basepath Web站点基础路径，默认为”/”
     */
    redirect: function(type, basepath) {
      historyObject["setup"](basepath, type);
      basepath = settings["basepath"];
      if (global.top == global.self) {
        var relative = parseURL(null, false, true)._relative;
        var path = windowLocation.pathname + windowLocation.search;
        if (isSupportHistoryAPI) {
          path = path.replace(/([^\/])$/, "$1/");
          if (
            relative != basepath &&
            new RegExp("^" + basepath + "$", "i").test(path)
          ) {
            windowLocation.replace(relative);
          }
        } else if (path != basepath) {
          path = path.replace(/([^\/])\?/, "$1/?");
          if (new RegExp("^" + basepath, "i").test(path)) {
            windowLocation.replace(
              basepath +
                "#" +
                path.replace(
                  new RegExp("^" + basepath, "i"),
                  settings["type"]
                ) +
                windowLocation.hash
            );
          }
        }
      }
    },
  
    /**
     * 新增一个state对象记录条目
     * @param {*} state 当前文档对象的state对象属性
     * @param {*} title 当前文档对象的title属性
     * @param {*} url 当前文档对象的URL
     */
    pushState: function(state, title, url) {
      var t = document.title;
      if (lastTitle != null) {
        document.title = lastTitle;
      }
      historyPushState && fastFixChrome(historyPushState, arguments);
      changeState(state, url);
      document.title = t;
      lastTitle = title;
    },
  
    /**
     * 在当前会话历史中更新当前活跃记录条目的状态对象、文档title和可选的URL
     * @param {*} state 当前文档对象的state对象属性
     * @param {*} title 当前文档对象的title属性
     * @param {*} url 当前文档对象的URL
     */
    replaceState: function(state, title, url) {
      var t = document.title;
      if (lastTitle != null) {
        document.title = lastTitle;
      }
      delete stateStorage[windowLocation.href];
      historyReplaceState && fastFixChrome(historyReplaceState, arguments);
      changeState(state, url, true);
      document.title = t;
      lastTitle = title;
    },
    /**
     * Object 'history.location' is similar to the
     * object 'window.location', except that in
     * HTML4 browsers it will behave a bit differently
     *
     * @namespace history
     */
    location: {
      set: function(value) {
        if (isUsedHistoryLocationFlag === 0) isUsedHistoryLocationFlag = 1;
        global.location = value;
      },
      get: function() {
        if (isUsedHistoryLocationFlag === 0) isUsedHistoryLocationFlag = 1;
        return locationObject;
      }
    },
    /**
     * A state object is an object representing
     * a user interface state.
     *
     * @namespace history
     */
    state: {
      get: function() {
        if (typeof stateStorage[windowLocation.href] === "object") {
          return JSON.parse(JSON.stringify(stateStorage[windowLocation.href]));
        } else if (typeof stateStorage[windowLocation.href] !== "undefined") {
          return stateStorage[windowLocation.href];
        } else {
          return null;
        }
      }
    }
  };

  /**
   * Properties for object 'history.location'.
   * Object 'history.location' is similar to the
   * object 'window.location', except that in
   * HTML4 browsers it will behave a bit differently
   *
   * @type {Object}
   */
  var locationDescriptors = {
    /**
     * Navigates to the given page.
     *
     * @namespace history.location
     */
    assign: function(url) {
      if (!isSupportHistoryAPI && ("" + url).indexOf("#") === 0) {
        changeState(null, url);
      } else {
        windowLocation.assign(url);
      }
    },
    /**
     * Reloads the current page.
     *
     * @namespace history.location
     */
    reload: function(flag) {
      windowLocation.reload(flag);
    },
    /**
     * Removes the current page from
     * the session history and navigates
     * to the given page.
     *
     * @namespace history.location
     */
    replace: function(url) {
      if (!isSupportHistoryAPI && ("" + url).indexOf("#") === 0) {
        changeState(null, url, true);
      } else {
        windowLocation.replace(url);
      }
    },
    /**
     * Returns the current page's location.
     *
     * @namespace history.location
     */
    toString: function() {
      return this.href;
    },
    /**
     * Returns the current origin.
     *
     * @namespace history.location
     */
    origin: {
      get: function() {
        if (customOrigin !== void 0) {
          return customOrigin;
        }
        if (!windowLocation.origin) {
          return (
            windowLocation.protocol +
            "//" +
            windowLocation.hostname +
            (windowLocation.port ? ":" + windowLocation.port : "")
          );
        }
        return windowLocation.origin;
      },
      set: function(value) {
        customOrigin = value;
      }
    },
    /**
     * Returns the current page's location.
     * Can be set, to navigate to another page.
     *
     * @namespace history.location
     */
    href: isSupportHistoryAPI
      ? null
      : {
          get: function() {
            return parseURL()._href;
          }
        },
    /**
     * Returns the current page's protocol.
     *
     * @namespace history.location
     */
    protocol: null,
    /**
     * Returns the current page's host and port number.
     *
     * @namespace history.location
     */
    host: null,
    /**
     * Returns the current page's host.
     *
     * @namespace history.location
     */
    hostname: null,
    /**
     * Returns the current page's port number.
     *
     * @namespace history.location
     */
    port: null,
    /**
     * Returns the current page's path only.
     *
     * @namespace history.location
     */
    pathname: isSupportHistoryAPI
      ? null
      : {
          get: function() {
            return parseURL()._pathname;
          }
        },
    /**
     * Returns the current page's search
     * string, beginning with the character
     * '?' and to the symbol '#'
     *
     * @namespace history.location
     */
    search: isSupportHistoryAPI
      ? null
      : {
          get: function() {
            return parseURL()._search;
          }
        },
    /**
     * Returns the current page's hash
     * string, beginning with the character
     * '#' and to the end line
     *
     * @namespace history.location
     */
    hash: isSupportHistoryAPI
      ? null
      : {
          set: function(value) {
            changeState(
              null,
              ("" + value).replace(/^(#|)/, "#"),
              false,
              lastURL
            );
          },
          get: function() {
            return parseURL()._hash;
          }
        }
  };

  /**
   * Just empty function
   *
   * @return void
   */
  function emptyFunction() {
    // dummy
  }

  // 解析URL字符串
  function parseURL(href, isWindowLocation, isNotAPI) {
    var re = /(?:([a-zA-Z0-9\-]+\:))?(?:\/\/(?:[^@]*@)?([^\/:\?#]+)(?::([0-9]+))?)?([^\?#]*)(?:(\?[^#]+)|\?)?(?:(#.*))?/;
    if (href != null && href !== "" && !isWindowLocation) {
      var current = parseURL(),
        base = document.getElementsByTagName("base")[0];
      if (!isNotAPI && base && base.getAttribute("href")) {
        // Fix for IE ignoring relative base tags.
        // See http://stackoverflow.com/questions/3926197/html-base-tag-and-local-folder-path-with-internet-explorer
        base.href = base.href;
        current = parseURL(base.href, null, true);
      }
      var _pathname = current._pathname,
        _protocol = current._protocol;
      // convert to type of string
      href = "" + href;
      // convert relative link to the absolute
      href = /^(?:\w+\:)?\/\//.test(href)
        ? href.indexOf("/") === 0
          ? _protocol + href
          : href
        : _protocol +
          "//" +
          current._host +
          (href.indexOf("/") === 0
            ? href
            : href.indexOf("?") === 0
            ? _pathname + href
            : href.indexOf("#") === 0
            ? _pathname + current._search + href
            : _pathname.replace(/[^\/]+$/g, "") + href);
    } else {
      href = isWindowLocation ? href : windowLocation.href;
      // if current browser not support History-API
      if (!isSupportHistoryAPI || isNotAPI) {
        // get hash fragment
        href = href.replace(/^[^#]*/, "") || "#";
        // form the absolute link from the hash
        // https://github.com/devote/HTML5-History-API/issues/50
        href =
          windowLocation.protocol.replace(/:.*$|$/, ":") +
          "//" +
          windowLocation.host +
          settings["basepath"] +
          href.replace(new RegExp("^#[/]?(?:" + settings["type"] + ")?"), "");
      }
    }
    // that would get rid of the links of the form: /../../
    anchorElement.href = href;
    // decompose the link in parts
    var result = re.exec(anchorElement.href);
    // host name with the port number
    var host = result[2] + (result[3] ? ":" + result[3] : "");
    // folder
    var pathname = result[4] || "/";
    // the query string
    var search = result[5] || "";
    // hash
    var hash = result[6] === "#" ? "" : result[6] || "";
    // relative link, no protocol, no host
    var relative = pathname + search + hash;
    // special links for set to hash-link, if browser not support History API
    var nohash =
      pathname.replace(
        new RegExp("^" + settings["basepath"], "i"),
        settings["type"]
      ) + search;
    // result
    return {
      _href: result[1] + "//" + host + relative,
      _protocol: result[1],
      _host: host,
      _hostname: result[2],
      _port: result[3] || "",
      _pathname: pathname,
      _search: search,
      _hash: hash,
      _relative: relative,
      _nohash: nohash,
      _special: nohash + hash
    };
  }

  //  判定宿主环境是否支持history特性
  function isSupportHistoryAPIDetect() {
    var ua = global.navigator.userAgent;
    if (
      (ua.indexOf("Android 2.") !== -1 || ua.indexOf("Android 4.0") !== -1) &&
      ua.indexOf("Mobile Safari") !== -1 &&
      ua.indexOf("Chrome") === -1 &&
      ua.indexOf("Windows Phone") === -1
    ) {
      return false;
    }
    return !!historyPushState;
  }

  //将事件监听器函数绑定在全局作用域的逻辑
  function maybeBindToGlobal(func) {
    if (
      func &&
      global &&
      global["EventTarget"] &&
      typeof global["EventTarget"].prototype.addEventListener === "function" &&
      typeof func.bind === "function"
    ) {
      return func.bind(global);
    }
    return func;
  }


  //  H5支持sessionStorage对象，来保存自定义的state对象
  // 注意sessionStorage对象只在当前会话过程有效
  function storageInitialize() {
    var sessionStorage;

    // 下面逻辑是判定浏览器是否原生支持sessionStorage特性，如果不支持则使用浏览器的cookie对象模拟
    try {
      sessionStorage = global["sessionStorage"];
      sessionStorage.setItem(sessionStorageKey + "t", "1");
      sessionStorage.removeItem(sessionStorageKey + "t");
    } catch (_e_) {
      sessionStorage = {
        getItem: function(key) {
          var cookie = document.cookie.split(key + "=");
          return (
            (cookie.length > 1 &&
              cookie
                .pop()
                .split(";")
                .shift()) ||
            "null"
          );
        },
        setItem: function(key, value) {
          var state = {};
         
          if ((state[windowLocation.href] = historyObject.state)) {
            document.cookie = key + "=" + JSON.stringify(state);
          }
        }
      };
    }

    try {
      // get cache from the storage in browser
      stateStorage =
        JSON.parse(sessionStorage.getItem(sessionStorageKey)) || {};
    } catch (_e_) {
      stateStorage = {};
    }

    // hang up the event handler to event unload page
    addEvent(
      eventNamePrefix + "unload",
      function() {
        // save current state's object
        sessionStorage.setItem(sessionStorageKey, JSON.stringify(stateStorage));
      },
      false
    );
  }

  /**
   * This method is implemented to override the built-in(native)
   * properties in the browser, unfortunately some browsers are
   * not allowed to override all the properties and even add.
   * For this reason, this was written by a method that tries to
   * do everything necessary to get the desired result.
   *
   * @param {Object} object The object in which will be overridden/added property
   * @param {String} prop The property name to be overridden/added
   * @param {Object} [descriptor] An object containing properties set/get
   * @param {Function} [onWrapped] The function to be called when the wrapper is created
   * @return {Object|Boolean} Returns an object on success, otherwise returns false
   */
  function redefineProperty(object, prop, descriptor, onWrapped) {
    var testOnly = 0;
    // test only if descriptor is undefined
    if (!descriptor) {
      descriptor = {
        set: emptyFunction
      };
      testOnly = 1;
    }
    // variable will have a value of true the success of attempts to set descriptors
    var isDefinedSetter = !descriptor.set;
    var isDefinedGetter = !descriptor.get;
    // for tests of attempts to set descriptors
    var test = {
      configurable: true,
      set: function() {
        isDefinedSetter = 1;
      },
      get: function() {
        isDefinedGetter = 1;
      }
    };

    try {
      // testing for the possibility of overriding/adding properties
      defineProperty(object, prop, test);
      // running the test
      object[prop] = object[prop];
      // attempt to override property using the standard method
      defineProperty(object, prop, descriptor);
    } catch (_e_) {}

    // If the variable 'isDefined' has a false value, it means that need to try other methods
    if (!isDefinedSetter || !isDefinedGetter) {
      // try to override/add the property, using deprecated functions
      if (object.__defineGetter__) {
        // testing for the possibility of overriding/adding properties
        object.__defineGetter__(prop, test.get);
        object.__defineSetter__(prop, test.set);
        // running the test
        object[prop] = object[prop];
        // attempt to override property using the deprecated functions
        descriptor.get && object.__defineGetter__(prop, descriptor.get);
        descriptor.set && object.__defineSetter__(prop, descriptor.set);
      }

      // Browser refused to override the property, using the standard and deprecated methods
      if (!isDefinedSetter || !isDefinedGetter) {
        if (testOnly) {
          return false;
        } else if (object === global) {
          // try override global properties
          try {
            // save original value from this property
            var originalValue = object[prop];
            // set null to built-in(native) property
            object[prop] = null;
          } catch (_e_) {}
          // This rule for Internet Explorer 8
          if ("execScript" in global) {
            /**
             * to IE8 override the global properties using
             * VBScript, declaring it in global scope with
             * the same names.
             */
            global["execScript"]("Public " + prop, "VBScript");
            global["execScript"]("var " + prop + ";", "JavaScript");
          } else {
            try {
              /**
               * This hack allows to override a property
               * with the set 'configurable: false', working
               * in the hack 'Safari' to 'Mac'
               */
              defineProperty(object, prop, { value: emptyFunction });
            } catch (_e_) {
              if (prop === "onpopstate") {
                /**
                 * window.onpopstate fires twice in Safari 8.0.
                 * Block initial event on window.onpopstate
                 * See: https://github.com/devote/HTML5-History-API/issues/69
                 */
                addEvent(
                  "popstate",
                  (descriptor = function() {
                    removeEvent("popstate", descriptor, false);
                    var onpopstate = object.onpopstate;
                    // cancel initial event on attribute handler
                    object.onpopstate = null;
                    setTimeout(function() {
                      // restore attribute value after short time
                      object.onpopstate = onpopstate;
                    }, 1);
                  }),
                  false
                );
                // cancel trigger events on attributes in object the window
                triggerEventsInWindowAttributes = 0;
              }
            }
          }
          // set old value to new variable
          object[prop] = originalValue;
        } else {
          // the last stage of trying to override the property
          try {
            try {
              // wrap the object in a new empty object
              var temp = Object.create(object);
              defineProperty(
                Object.getPrototypeOf(temp) === object ? temp : object,
                prop,
                descriptor
              );
              for (var key in object) {
                // need to bind a function to the original object
                if (typeof object[key] === "function") {
                  temp[key] = object[key].bind(object);
                }
              }
              try {
                // to run a function that will inform about what the object was to wrapped
                onWrapped.call(temp, temp, object);
              } catch (_e_) {}
              object = temp;
            } catch (_e_) {
              // sometimes works override simply by assigning the prototype property of the constructor
              defineProperty(object.constructor.prototype, prop, descriptor);
            }
          } catch (_e_) {
            // all methods have failed
            return false;
          }
        }
      }
    }

    return object;
  }

  /**
   * Adds the missing property in descriptor
   *
   * @param {Object} object An object that stores values
   * @param {String} prop Name of the property in the object
   * @param {Object|null} descriptor Descriptor
   * @return {Object} Returns the generated descriptor
   */
  function prepareDescriptorsForObject(object, prop, descriptor) {
    descriptor = descriptor || {};
    // the default for the object 'location' is the standard object 'window.location'
    object = object === locationDescriptors ? windowLocation : object;
    // setter for object properties
    descriptor.set =
      descriptor.set ||
      function(value) {
        object[prop] = value;
      };
    // getter for object properties
    descriptor.get =
      descriptor.get ||
      function() {
        return object[prop];
      };
    return descriptor;
  }

  /**
   *
   * @param {*} event 事件名称
   * @param {*} listener 事件监听器函数
   * @param {*} capture W3C中捕获/冒泡的boolean
   */
  function addEventListener(event, listener, capture) {
    if (event in eventsList) {
      // here stored the event listeners 'popstate/hashchange'
      eventsList[event].push(listener);
    } else {
      if (arguments.length > 3) {
        addEvent(event, listener, capture, arguments[3]);
      } else {
        addEvent(event, listener, capture);
      }
    }
  }

  // 根据事件名称和事件监听器名，解绑该监听器
  function removeEventListener(event, listener, capture) {
    var list = eventsList[event];
    if (list) {
      for (var i = list.length; i--; ) {
        if (list[i] === listener) {
          list.splice(i, 1);
          break;
        }
      }
    } else {
      removeEvent(event, listener, capture);
    }
  }

  //  分发事件类别
  function dispatchEvent(event, eventObject) {
    var eventType = (
      "" + (typeof event === "string" ? event : event.type)
    ).replace(/^on/, "");
    var list = eventsList[eventType];
    if (list) {
      // need to understand that there is one object of Event
      eventObject = typeof event === "string" ? eventObject : event;
      if (eventObject.target == null) {
        // need to override some of the properties of the Event object
        for (
          var props = ["target", "currentTarget", "srcElement", "type"];
          (event = props.pop());

        ) {
          // use 'redefineProperty' to override the properties
          eventObject = redefineProperty(eventObject, event, {
            get:
              event === "type"
                ? function() {
                    return eventType;
                  }
                : function() {
                    return global;
                  }
          });
        }
      }
      if (triggerEventsInWindowAttributes) {
        // run function defined in the attributes 'onpopstate/onhashchange' in the 'window' context
        (
          (eventType === "popstate"
            ? global.onpopstate
            : global.onhashchange) || emptyFunction
        ).call(global, eventObject);
      }
      // run other functions that are in the list of handlers
      for (var i = 0, len = list.length; i < len; i++) {
        list[i].call(global, eventObject);
      }
      return true;
    } else {
      return dispatch(event, eventObject);
    }
  }

  /**
   * popstate事件触发逻辑
   */
  function firePopState() {
    var o = document.createEvent
      ? document.createEvent("Event")
      : document.createEventObject();
    if (o.initEvent) {
      o.initEvent("popstate", false, false);
    } else {
      o.type = "popstate";
    }
    o.state = historyObject.state;
   
    // 触发事件
    dispatchEvent(o);
  }

  /**
   * 对于不支持H5浏览器进行文档对象初始化
   */
  function fireInitialState() {
    if (isFireInitialState) {
      isFireInitialState = false;
      firePopState();
    }
  }

  /**
   * 改变当前浏览记录的state数据
   * @param {Object} state history对象保存的state属性
   * @param {string} [url] URL地址
   * @param {Boolean} [replace] 地址替换函数
   * @param {string} [lastURLValue] 前一次URL地址
   * @return void
   */
  function changeState(state, url, replace, lastURLValue) {
    if (!isSupportHistoryAPI) {
      // if not used implementation history.location
      if (isUsedHistoryLocationFlag === 0) {
        isUsedHistoryLocationFlag = 2;
      }
      // normalization url
      var urlObject = parseURL(
        url,
        isUsedHistoryLocationFlag === 2 && ("" + url).indexOf("#") !== -1
      );
      // if current url not equal new url
      if (urlObject._relative !== parseURL()._relative) {
        // if empty lastURLValue to skip hash change event
        lastURL = lastURLValue;
        if (replace) {
          // only replace hash, not store to history
          windowLocation.replace("#" + urlObject._special);
        } else {
          // change hash and add new record to history
          windowLocation.hash = urlObject._special;
        }
      }
    } else {
      lastURL = windowLocation.href;
    }
    if (!isSupportStateObjectInHistory && state) {
      stateStorage[windowLocation.href] = state;
    }
    isFireInitialState = false;
  }

  /**
   * 处理地址栏URL的哈希部分变化逻辑
   * @param {*} event 地址栏哈希值发生变化触发事件
   */
  function onHashChange(event) {
    var fireNow = lastURL;

    lastURL = windowLocation.href;
    //
    if (fireNow) {
      // if checkUrlForPopState equal current url, this means that the event was raised popstate browser
      if (checkUrlForPopState !== windowLocation.href) {
        // otherwise,
        // the browser does not support popstate event or just does not run the event by changing the hash.
        firePopState();
      }
      // current event object
      event = event || global.event;

      var oldURLObject = parseURL(fireNow, true);
      var newURLObject = parseURL();
      // HTML4 browser not support properties oldURL/newURL
      if (!event.oldURL) {
        event.oldURL = oldURLObject._href;
        event.newURL = newURLObject._href;
      }
      if (oldURLObject._hash !== newURLObject._hash) {
        // if current hash not equal previous hash
        dispatchEvent(event);
      }
    }
  }

  /**
   * 页面加载完毕触发的事件
   *
   * @param {*} [noScroll] 表示保持滚动位置的逻辑
   * @return void
   */
  function onLoad(noScroll) {
    // Get rid of the events popstate when the first loading a document in the webkit browsers
    setTimeout(function() {
      // hang up the event handler for the built-in popstate event in the browser
      addEvent(
        "popstate",
        function(e) {
          // set the current url, that suppress the creation of the popstate event by changing the hash
          checkUrlForPopState = windowLocation.href;
          // for Safari browser in OS Windows not implemented 'state' object in 'History' interface
          // and not implemented in old HTML4 browsers
          if (!isSupportStateObjectInHistory) {
            e = redefineProperty(e, "state", {
              get: function() {
                return historyObject.state;
              }
            });
          }
          // send events to be processed
          dispatchEvent(e);
        },
        false
      );
    }, 0);
    // for non-HTML5 browsers
    if (
      !isSupportHistoryAPI &&
      noScroll !== true &&
      "location" in historyObject
    ) {
      // scroll window to anchor element
      scrollToAnchorId(locationObject.hash);
      // fire initial state for non-HTML5 browser after load page
      fireInitialState();
    }
  }

  /**
   * Finds the closest ancestor anchor element (including the target itself).
   *
   * @param {HTMLElement} target The element to start scanning from.
   * @return {HTMLElement} An element which is the closest ancestor anchor.
   */
  function anchorTarget(target) {
    while (target) {
      if (target.nodeName === "A") return target;
      target = target.parentNode;
    }
  }

  /**
   * Handles anchor elements with a hash fragment for non-HTML5 browsers
   *
   * @param {Event} e
   */
  function onAnchorClick(e) {
    var event = e || global.event;
    var target = anchorTarget(event.target || event.srcElement);
    var defaultPrevented =
      "defaultPrevented" in event
        ? event["defaultPrevented"]
        : event.returnValue === false;
    if (target && target.nodeName === "A" && !defaultPrevented) {
      var current = parseURL();
      var expect = parseURL(target.getAttribute("href", 2));
      var isEqualBaseURL =
        current._href.split("#").shift() === expect._href.split("#").shift();
      if (isEqualBaseURL && expect._hash) {
        if (current._hash !== expect._hash) {
          locationObject.hash = expect._hash;
        }
        scrollToAnchorId(expect._hash);
        if (event.preventDefault) {
          event.preventDefault();
        } else {
          event.returnValue = false;
        }
      }
    }
  }

  /**
   * 将页面滚动到具有HASH锚点的页面位置
   *
   * @param hash URL中的哈希部分
   */
  function scrollToAnchorId(hash) {
    var target = document.getElementById(
      (hash = (hash || "").replace(/^#/, ""))
    );
    if (target && target.id === hash && target.nodeName === "A") {

      // 获得锚点元素相对于document元素左上角的坐标偏移，并调用浏览器原生的scrollTo方法滚动到指定位置
      var rect = target.getBoundingClientRect();
      global.scrollTo(
        documentElement.scrollLeft || 0,
        rect.top +
          (documentElement.scrollTop || 0) -
          (documentElement.clientTop || 0)
      );
    }
  }

 // 对history库的初始化过程
  function initialize() {
    /**
     * Get custom settings from the query string
     */
    var scripts = document.getElementsByTagName("script");
    var src = (scripts[scripts.length - 1] || {}).src || "";
    var arg = src.indexOf("?") !== -1 ? src.split("?").pop() : "";
    arg.replace(/(\w+)(?:=([^&]*))?/g, function(a, key, value) {
      settings[key] = (value || "").replace(/^(0|false)$/, "");
    });

    /**
     * 绑定事件监听URL哈希变化事件
     */
    addEvent(eventNamePrefix + "hashchange", onHashChange, false);

    // a list of objects with pairs of descriptors/object
    var data = [
      locationDescriptors,
      locationObject,
      eventsDescriptors,
      global,
      historyDescriptors,
      historyObject
    ];

    // if browser support object 'state' in interface 'History'
    if (isSupportStateObjectInHistory) {
      // remove state property from descriptor
      delete historyDescriptors["state"];
    }

    // initializing descriptors
    for (var i = 0; i < data.length; i += 2) {
      for (var prop in data[i]) {
        if (data[i].hasOwnProperty(prop)) {
          if (typeof data[i][prop] !== "object") {
            // If the descriptor is a simple function, simply just assign it an object
            data[i + 1][prop] = data[i][prop];
          } else {
            // prepare the descriptor the required format
            var descriptor = prepareDescriptorsForObject(
              data[i],
              prop,
              data[i][prop]
            );
            // try to set the descriptor object
            if (
              !redefineProperty(data[i + 1], prop, descriptor, function(n, o) {
                // is satisfied if the failed override property
                if (o === historyObject) {
                  // the problem occurs in Safari on the Mac
                  global.history = historyObject = data[i + 1] = n;
                }
              })
            ) {
              // if there is no possibility override.
              // This browser does not support descriptors, such as IE7

              // remove previously hung event handlers
              removeEvent(eventNamePrefix + "hashchange", onHashChange, false);

              // fail to initialize :(
              return false;
            }

            // create a repository for custom handlers onpopstate/onhashchange
            if (data[i + 1] === global) {
              eventsList[prop] = eventsList[prop.substr(2)] = [];
            }
          }
        }
      }
    }

    // check settings
    historyObject["setup"]();

    // redirect if necessary
    if (settings["redirect"]) {
      historyObject["redirect"]();
    }

    // initialize
    if (settings["init"]) {
      // You agree that you will use window.history.location instead window.location
      isUsedHistoryLocationFlag = 1;
    }

    // If browser does not support object 'state' in interface 'History'
    if (!isSupportStateObjectInHistory && JSON) {
      storageInitialize();
    }

    // track clicks on anchors
    if (!isSupportHistoryAPI) {
      document[addEventListenerName](
        eventNamePrefix + "click",
        onAnchorClick,
        false
      );
    }

    if (document.readyState === "complete") {
      onLoad(true);
    } else {
      if (
        !isSupportHistoryAPI &&
        parseURL()._relative !== settings["basepath"]
      ) {
        isFireInitialState = true;
      }
      /**
       * Need to avoid triggering events popstate the initial page load.
       * Hang handler popstate as will be fully loaded document that
       * would prevent triggering event onpopstate
       */
      addEvent(eventNamePrefix + "load", onLoad, false);
    }

    // everything went well
    return true;
  }

  /**
   * Starting the library
   */
  if (!initialize()) {
    // if unable to initialize descriptors
    // therefore quite old browser and there
    // is no sense to continue to perform
    return;
  }

  /**
   * If the property history.emulate will be true,
   * this will be talking about what's going on
   * emulation capabilities HTML5-History-API.
   * Otherwise there is no emulation, ie the
   * built-in browser capabilities.
   *
   * @type {boolean}
   * @const
   */
  historyObject["emulate"] = !isSupportHistoryAPI;

  /**
   * Replace the original methods on the wrapper
   */
  global[addEventListenerName] = addEventListener;
  global[removeEventListenerName] = removeEventListener;
  global[dispatchEventName] = dispatchEvent;

  return historyObject;
});
