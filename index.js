/* @TODO
 * 1. Deduplication cookie management
 * 2. Multiple partner id support from user fields
 * 3. Check if possible to copy data from FB Pixel & Google Ads events
 * 4. Optionally double hash email with sha256 if not plain text
 * 5. Enhanced error logging 
 * 6. Query permissions before running the actual script
 * 7. Add vertical specific parameter templates
 * 8. Add search events support
 * 9. Add Flush event feature for multiple partner deployment w/ different setups
 * 10. Change viewHome fallback logic
 * 11. When automatic detection is selected, enable user to choose a source variable (!?)
 * 12. Add help text/tooltip for each field
 * 13. Detect d-m-t without user input
 * 14. Fire home page event if path=/|/index.(html|asp|aspx)
*/



/*
 * APIs
 */
const logToConsole = require('logToConsole');
const copyFromDataLayer = require('copyFromDataLayer');
const createQueue = require('createQueue');
const callInWindow = require('callInWindow');
const injectScript = require('injectScript');
const setInWindow = require('setInWindow');
const copyFromWindow = require('copyFromWindow');


/*
 *  Tag configuration/user inputs
 */
const criteoAccountId = data.accountId;
const deviceType = data.deviceType;
const userEmail = data.userEmail || "";
const currencyCode = data.currencyCode;
const eventDetectionMethod = data.eventDetection;
const userEventType = data.userEventType;
const viewItemProductId = data.productId;
const viewListProductIds = data.productIds;
const viewBasketObject = data.basketObject;
const trackTransactionId = data.transactionId;
const trackTransactionObject = data.transactionObject;
const addCustomParameters = data.addCustomParameters;
const customParamList = data.paramTable;
const deduplicationValue = data.dedup;

/*
 * Checks if product data is inside an array
 * Not used now, needs to be updated.
 */
const isArray = (toCheck) => {
  
  let arr = callInWindow('toString.call', toCheck) === '[object Array]';
  
  let out = {
    valid: false, 
    msg: ''
  };

  if (arr) {
    
    if (!toCheck.length) {

      out['msg'] = 'Array with zero elements.';
      return out;
    }
    
    out['valid'] = true;
    out['msg'] = toCheck[0];
    
    return out;
  }
  
  out['msg'] = 'Not an array.';
  
  return out;
};

/*
 * Ref: https://stackoverflow.com/questions/24221803/javascript-access-object-multi-level-property-using-variable#answer-24221895
 * Not used now, needs to be updated
 */
const validateObjectFormat = (eeObject, objPath) => {
 let targetPath = objPath.split('.');
 let current = eeObject;
 let nextPath = '';
 let prevPath = '[ecommerce object]';
 let searchFor = '';
 let pathLength = objPath.length + 1;
 while (pathLength) {
   if (!current) {
     return false;
   }
   if (searchFor === 'list') {
     searchFor = '';
     let arrayCheck = isArray(current);
     if (arrayCheck.valid) {
       current = arrayCheck.msg;
     } else {
       onFailure(arrayCheck.msg);
       return false;
     }
   }
   nextPath = targetPath.shift();
   prevPath += '[' + nextPath + ']';
   nextPath = nextPath === '[]' ? (searchFor = 'list', pathLength--, targetPath.shift()) : nextPath;
   current = current[nextPath];
   pathLength--;
 }
 return true;
};

/*
 * Checks if there is any of 4 enhanced ecommerce events present in dataLayer,
 * Otherwise return viewHome event.
 */
const getEnhancedEcommerceEvent = (eeObject) => {

  const enhancedEcommerceEventList = ['detail', 'impressions', 'checkout', 'purchase'];

  let matchingEvent = null;

  for (var i = 0; i < enhancedEcommerceEventList.length; i++) {

    if (eeObject.hasOwnProperty(enhancedEcommerceEventList[i])) {
      
      matchingEvent = enhancedEcommerceEventList[i];
      break;
    }
  }

  return matchingEvent || 'viewHome';
};

/*
 * Extract product info from checkout & transaction enh. ecommerce events.
 */
const getBasketDetails = (eeObject, eeEvent) => {

  //['id', 'price', 'quantity'].forEach(prop => validateObjectFormat(eeObject, eeEvent + '.[].products.' + prop));

  return eeObject[eeEvent].products.map((product) => {
    return {
      id: product.id || false,
      price: (product.price || '1.00'),
      quantity: (product.quantity || 1)
    };
  }).filter(p => p.id);
};

/*
 *  Map enhanced ecommerce events to Criteo events.
 */
const eventMapper = {
  detail: (eeObject, sourceType) => {
    
    //validateObjectFormat(eeObject, 'detail.[].products.id');
    return {
      'event': 'viewItem',
      'item': sourceType === 'ee' ? eeObject.detail.products[0].id : viewItemProductId
    };
  },
  impressions: (eeObject, sourceType) => {

    //validateObjectFormat(eeObject, '[].impressions.id');
    return {
      'event': 'viewList',
      'item': (sourceType === 'ee' ? eeObject.impressions.map((p) => {return p.id || false;}).filter(p => p) : viewListProductIds).slice(0,3)
    };
  },
  checkout: (eeObject, sourceType) => {
    const eventObject = {
      'event': 'viewBasket',
      'item': sourceType === 'ee' ? getBasketDetails(eeObject, 'checkout') : viewBasketObject
    };
    if (currencyCode) {
      eventObject.currency = currencyCode.toUpperCase();
    }
    return eventObject;
  },
  purchase: (eeObject, sourceType) => {

    //validateObjectFormat(eeObject, 'purchase.actionField.id');
    const eventObject = {
      'event': 'trackTransaction',
      'id': sourceType === 'ee' ? eeObject.purchase.actionField.id : trackTransactionId,
      'item': sourceType === 'ee' ? getBasketDetails(eeObject, 'purchase') : trackTransactionObject
    };
    if (currencyCode) {
      eventObject.currency = currencyCode.toUpperCase();
    }
    return eventObject;
  },
  viewHome: () => {
    return {
      'event': 'viewHome'
    };
  }
};

/*
 * Event to be sent
 */
let targetEvent = '';

/*
 * Keeps track of Criteo events sent inside current window.
 */
const reportEvent = (eventList, newEvent) => {

  const newList = eventList ? eventList.concat([newEvent]) : [newEvent];

  setInWindow('__sentCriteoEventsInWindow', newList, true);
};

/*
 * Checks if viewHome sent before in current window.
 */
const checkViewHomeEvent = (eventList) => {

  return eventList.indexOf('viewHome') > -1;
};

/*
 * Log with label
 */
const logger = (msg) => {

  logToConsole('Criteo_OneTag_CT_DEBUGGER:: >', msg);
};


/*
 * Custom success fn.
 */
const onSuccess = (msg) => {
  
  reportEvent(sentCriteoEventsInWindow, targetEvent);

  logger(msg || 'Tag complete.');
  
  data.gtmOnSuccess();
};

/*
 * Custom failure fn.
 */
const onFailure = (msg) => {

  logger(msg || 'Tag did not send any events.');

  data.gtmOnFailure();
};

/*
 * Script runner
 */
const runScript = () => {

  injectScript('https://static.criteo.net/js/ld/ld.js', onSuccess, onFailure, 'criteoOneTagCT');
};

/*
 * Pushes event data to Criteo's data layer.
 */
const buildCriteoEvent = (eventType, eeObject, sourceType, mapper, cb) => {

  var targetCriteoEvent = mapper[eventType](eeObject, sourceType);
  
  if (addCustomParameters && customParamList) {

    customParamList.forEach(e => {
      targetCriteoEvent[e.paramName] = e.paramValue;
    });

  } 
  
  if (eventType === 'purchase' && deduplicationValue) {

    if (['1', '0', 0, 1].indexOf(deduplicationValue) > -1) {
    
      targetCriteoEvent['deduplication'] = deduplicationValue;
    } else {
    
      logger('Warning: Deduplication parameter needs to be one of [1, 0]');
    }
  }

  targetCriteoEvent['tms'] = "gtm-criteo-template";

  callInWindow('criteo_q.push',
    {'event': 'setAccount', 'account': criteoAccountId},
    {'event': 'setEmail', 'email': userEmail},
    {'event': 'setSiteType', 'type': deviceType},
    targetCriteoEvent
  );
  targetEvent = eventType;

  cb();
};

/*
 * Create a list of Criteo events that are going to be sent.
 * No override.
 */
setInWindow('__sentCriteoEventsInWindow', []);

/*
 * Get the list of Criteo events.
 */
const sentCriteoEventsInWindow = copyFromWindow('__sentCriteoEventsInWindow');

/*
 * Initialize Criteo's data layer.
 * Will not use the pusher fn. Sending multiple events in current window is easier with seperate criteo_q.push calls
 */
const criteoLayer = createQueue('criteo_q');

/*
 * Build the event.
 */
if (eventDetectionMethod !== 'enhancedEcommerce') {
  // Call event with user inputs.
  buildCriteoEvent(
    userEventType, null, 'ms', eventMapper, runScript
  );
} else {
  // Using version 1 to get the latest push.
  const enhancedEcommerceObject = copyFromDataLayer('ecommerce', 1);
  // If no enh. ecommerce object
  if (!enhancedEcommerceObject) {

    onFailure('Enhanced e-commerce object inside dataLayer is undefined.');
  } else {
    // Get enh. ecommerce event
    const autoEventType = getEnhancedEcommerceEvent(enhancedEcommerceObject);
    // Check if event is viewHome to prevent duplicate calls
    // Since its the default/fallback event if enh. ecommerce event is other than the four accepted ones.
    if (autoEventType === 'viewHome') {

      let viewHomeSentBefore = checkViewHomeEvent(sentCriteoEventsInWindow);

      if (viewHomeSentBefore) {
        // Already sent viewHome, quit in order to prevent duplicates.
        onFailure('Window already sent viewHome event before. Duplicate home page events blocked.');
      } else {
        // First viewHome event in window, run the script.
        buildCriteoEvent(
          autoEventType, enhancedEcommerceObject, 'ee', eventMapper, runScript
        );
      }
    } else {
      // One of ['detail', 'impressions', 'checkout', 'purchase'].
      buildCriteoEvent(
        autoEventType, enhancedEcommerceObject, 'ee', eventMapper, runScript
      );
    }
  }
}
