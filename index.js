var Accessory, Service, Characteristic, UUIDGen, _homebridge, FakeGatoHistoryService;
const exec = require("child_process").exec;
const moment = require('moment');
const request = require('request');
const inherits = require('util').inherits;
const underscore = require('underscore');
const NodeCache  = require('node-cache');

const HomeKitTypes = require('./types/general.js');
const EveTypes = require('./types/eve.js');

require('events').EventEmitter.defaultMaxListeners = 20;

var switchService;
var contactService;
var command;
var newstatus = 0;

module.exports = function (homebridge) {
	const cache = new NodeCache({ stdTTL: 1 })
	_homebridge = homebridge
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	FakeGatoHistoryService = require('fakegato-history')(homebridge);
	
	HomeKitTypes.registerWith(homebridge.hap);
	EveTypes.registerWith(homebridge.hap);
	
	UUIDGen = homebridge.hap.uuid;
	homebridge.registerAccessory("homebridge-sonoff-fg", "SonoffTasmotaHTTP", Sonoff);
}

function Sonoff(log, config) {
  this.log = log;
  this.config = config;
  this.displayName = this.config['name'];
  this.name = this.config['name'];
  this.mac = this.config['mac'];
  this.relay = this.config['relay'] || '';
  this.hostname = this.config['hostname'] || 'sonoff';
  this.manufacturer = this.config['manufacturer'] || 'Sonoff';
  this.model = this.config['model'] || 'Basic';
  this.user = this.config['user'] || 'admin';
  this.pass = this.config['pass'] || '';
  this.auth_url = '?user=' + this.user + '&password=' + this.pass;
	if (this.relay !== "") {
		this.displayName = this.hostname+"_"+this.relay;
		this.serial = this.config['serial'] || this.hostname+"_"+this.relay;
	} else {
		this.displayName = this.hostname;
		this.serial = this.config['serial'] || this.hostname;
	}
	
	const now = moment().unix()
	this.historyExtra = { lastReset: now - moment('2001-01-01T00:00:00Z').unix(), lastChange: now }
	underscore.extend(this.historyExtra, { 
		timesOpened    :  0, 
		openDuration   :  0, 
		closedDuration :  0, 
		lastActivation :  0, 
		lastStatus     :  0
	})
	
  this.log('Sonoff Tasmota HTTP Initialized');
}

Sonoff.prototype = {
	_request: function(cmd, callback) {
		this.log("--------> _request");
    const url = 'http://' + this.hostname + '/cm' + this.auth_url + '&cmnd=' + cmd;
    //this.log('requesting: ' + url);
    request({
      uri:     url,
      timeout: this.timeout,
    }, callback);
	},
	getState: function (callback) {
    var self = this;
    self.log("--------> getState");
    var newstatus;
    this._request('Power' + self.relay, function (error, response, body) {
      if (error) {
        self.log('error: ' + error);
        return callback(error);
      }
      var sonoff_reply = JSON.parse(body); // {"status":"ON"}
      //self.log('Sonoff HTTP: ' + self.hostname + ', Relay ' + self.relay + ', Get State: ' + JSON.stringify(sonoff_reply));
      switch (sonoff_reply['POWER' + self.relay]) {
        case 'ON':
         	newstatus = 1;
        	if (callback !== undefined) {
        		callback(null, 1);
        	} else {
        		return 1;
        	}
          break;
        case 'OFF':
        	newstatus = 0;
        	if (callback !== undefined) {
          	callback(null, 0);
					} else {
						return 0;
					}
          break;
      }
			self.log("--------> update values");
			const now = moment().unix()
			const delta = now - self.historyExtra.lastChange
			const contact = Characteristic.ContactSensorState[newstatus === 0 ? 'CONTACT_DETECTED' : 'CONTACT_NOT_DETECTED']
			if (self.historyExtra.lastStatus !== contact) {
				self.historyExtra.lastStatus = contact
				if (contact == Characteristic.ContactSensorState.CONTACT_NOT_DETECTED) {
					self.historyExtra.timesOpened++
					self.historyExtra.closedDuration += delta
					self.historyExtra.lastActivation = now - self.loggingService.getInitialTime()
				} else {
					self.historyExtra.openDuration += delta
				}
				self.historyExtra.lastChange = now
				self.loggingService.setExtraPersistedData(self.historyExtra)
			}
		
			self.contactService.getCharacteristic(Characteristic.ContactSensorState).updateValue(self.historyExtra.lastStatus)
				.on('change', self.getStatusActive.bind(self));
			self.contactService.getCharacteristic(Characteristic.TimesOpened).updateValue(self.historyExtra.timesOpened)
				.on('change', self.getTimesOpened.bind(self));
			self.contactService.getCharacteristic(Characteristic.ClosedDuration).updateValue(self.historyExtra.closedDuration)
				.on('change', self.getClosedDuration.bind(self));
			self.contactService.getCharacteristic(Characteristic.OpenDuration).updateValue(self.historyExtra.openDuration)
				.on('change', self.getOpenDuration.bind(self));
			self.contactService.getCharacteristic(Characteristic.LastActivation).updateValue(self.historyExtra.lastActivation)
				.on('change', self.getLastActivation.bind(self));
			
			self.loggingService.addEntry({time: moment().unix(), status: self.historyExtra.lastStatus});
    });
		
		/*
		clearTimeout(self.timer);
		self.timer = setTimeout(function() {
			self.getState();
		}.bind(self), 300000);
		*/
	},
  getInUse: function (callback) {
    this.log('--------> getInUse');
    this.getState(function (error, inuse) {
      if (error) {
        callback(error);
      } else {
        callback(null, Boolean(inuse));
      }
    });
  },
  setState: function (toggle, callback) {
  	this.log("--------> setState");
    var newstate = '%20Off';
    if (toggle) {
      newstate = '%20On';
    }
    var self = this;
    var newstatus;
    this._request('Power' + self.relay + newstate, function (error, response, body) {
      if (error) {
        self.log('error: ' + error);
        return callback(error);
      }
      var sonoff_reply = JSON.parse(body); // {"status":"ON"}
      //self.log('Sonoff HTTP: ' + self.hostname + ', Relay ' + self.relay + ', Set State: ' + JSON.stringify(sonoff_reply));
      switch (sonoff_reply['POWER' + self.relay]) {
        case 'ON':
        	newstatus = 1;
          callback();
          break;
        case 'OFF':
        	newstatus = 0;
          callback();
          break;
      }
			self.log("--------> update values");
			const now = moment().unix()
			const delta = now - self.historyExtra.lastChange
			const contact = Characteristic.ContactSensorState[newstatus === 0 ? 'CONTACT_DETECTED' : 'CONTACT_NOT_DETECTED']
			if (self.historyExtra.lastStatus !== contact) {
				self.historyExtra.lastStatus = contact
				if (contact == Characteristic.ContactSensorState.CONTACT_NOT_DETECTED) {
					self.historyExtra.timesOpened++
					self.historyExtra.closedDuration += delta
					self.historyExtra.lastActivation = now - self.loggingService.getInitialTime()
				} else {
					self.historyExtra.openDuration += delta
				}
				self.historyExtra.lastChange = now
				self.loggingService.setExtraPersistedData(self.historyExtra)
			}
		
			self.contactService.getCharacteristic(Characteristic.ContactSensorState).updateValue(self.historyExtra.lastStatus)
				.on('change', self.getStatusActive.bind(self));
			self.contactService.getCharacteristic(Characteristic.TimesOpened).updateValue(self.historyExtra.timesOpened)
				.on('change', self.getTimesOpened.bind(self));
			self.contactService.getCharacteristic(Characteristic.ClosedDuration).updateValue(self.historyExtra.closedDuration)
				.on('change', self.getClosedDuration.bind(self));
			self.contactService.getCharacteristic(Characteristic.OpenDuration).updateValue(self.historyExtra.openDuration)
				.on('change', self.getOpenDuration.bind(self));
			self.contactService.getCharacteristic(Characteristic.LastActivation).updateValue(self.historyExtra.lastActivation)
				.on('change', self.getLastActivation.bind(self));
			
			self.loggingService.addEntry({time: moment().unix(), status: self.historyExtra.lastStatus});
    });
  },
	identify: function(callback) {
		this.log("Identify requested!");
		callback(); // success
	},
	getStatusActive: function (callback) {
		this.log("--------> getStatusActive");
		var newobject = JSON.stringify(callback);
		if (typeof newobject.oldValue !== undefined && newobject.oldValue !== null) {
			return this.historyExtra.lastStatus;
		} else {
			callback(null, this.historyExtra.lastStatus);
		}
	},
	getTimesOpened: function (callback) {
		this.log("--------> getTimesOpened");
		var newobject = JSON.stringify(callback);
		if (typeof newobject.oldValue !== undefined && newobject.oldValue !== null) {
			return this.historyExtra.timesOpened;
		} else {
			callback(null, this.historyExtra.timesOpened);
		}
		this.contactService.getCharacteristic(Characteristic.TimesOpened).updateValue(this.historyExtra.timesOpened)
			.on('change', this.getTimesOpened.bind(this));
	},
	getClosedDuration: function (callback) {
		this.log("--------> getClosedDuration");
		var newobject = JSON.stringify(callback);
		if (typeof callback !== undefined && callback !== null) {
			return this.historyExtra.closedDuration;
		} else {
			callback(null, this.historyExtra.closedDuration);
		}
		this.contactService.getCharacteristic(Characteristic.ClosedDuration).updateValue(this.historyExtra.closedDuration)
			.on('change', this.getClosedDuration.bind(this));
	},
	getOpenDuration: function (callback) {
		this.log("--------> getOpenDuration");
		var newobject = JSON.stringify(callback);
		if (typeof newobject.oldValue !== undefined && newobject.oldValue !== null) {
			return this.historyExtra.openDuration;
		} else {
			callback(null, this.historyExtra.openDuration);
		}
		this.contactService.getCharacteristic(Characteristic.OpenDuration).updateValue(this.historyExtra.openDuration)
			.on('change', this.getOpenDuration.bind(this));
	},
	getLastActivation: function (callback) {
		this.log("--------> getLastActivation");
		var newobject = JSON.stringify(callback);
		if (typeof newobject.oldValue !== undefined && newobject.oldValue !== null) {
			return this.historyExtra.lastActivation;
		} else {
			callback(null, this.historyExtra.lastActivation);
		}
		this.contactService.getCharacteristic(Characteristic.LastActivation).updateValue(this.historyExtra.lastActivation)
			.on('change', this.getLastActivation.bind(this));
	},
	getContactSensorState: function (callback) {
		this.log("--------> getContactSensorState");
		var newobject = JSON.stringify(callback);
		if (typeof newobject.oldValue !== undefined && newobject.oldValue !== null) {
			return this.historyExtra.lastStatus;
		} else {
			callback(null, this.historyExtra.lastStatus);
		}
		this.contactService.getCharacteristic(Characteristic.ContactSensorState).updateValue(this.historyExtra.lastStatus)
			.on('change', self.getStatusActive.bind(this));
	},
	getResetTotal: function (callback) {
		this.log("--------> getResetTotal");
		var newobject = JSON.stringify(callback);
		this.loggingService.getCharacteristic(Characteristic.ResetTotal).updateValue(this.historyExtra.lastReset)
		if (typeof newobject.oldValue !== undefined && newobject.oldValue !== null) {
			return this.historyExtra.lastReset;
		} else {
			callback(null, this.historyExtra.lastReset);
		}
	},
  setResetTotal: function (value, callback) {
  	this.log("--------> setResetTotal");
		this.historyExtra.lastReset = value
		this.loggingService.setExtraPersistedData(this.historyExtra)
		this.loggingService.getCharacteristic(Characteristic.ResetTotal).updateValue(this.historyExtra.lastReset)
		callback(null)
	},
	loadExtra: function () {
		this.log("--------> loadExtra");
		let extra
		if (!this.loggingService.isHistoryLoaded()) return setTimeout(this.loadExtra.bind(this), 100)
		extra = this.loggingService.getExtraPersistedData()
		if (extra) this.historyExtra = extra
		else this.loggingService.setExtraPersistedData(this.historyExtra)
	},
	
	getServices: function() {
		var informationService = new Service.AccessoryInformation();
		informationService
		.setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
		.setCharacteristic(Characteristic.Name, this.displayName)
		.setCharacteristic(Characteristic.Identify, this.displayName)
		.setCharacteristic(Characteristic.Model, this.model)
		.setCharacteristic(Characteristic.SerialNumber, this.serial)
		.setCharacteristic(Characteristic.FirmwareRevision, "0.0.2")
		.setCharacteristic(Characteristic.HardwareRevision, "0.0.2");

		this.contactService = new Service.Outlet(this.name);
		//this.switchService = new Service.Switch(this.name);
		//this.contactService = new Service.ContactSensor(this.name+"contact");
		this.contactService
			.getCharacteristic(Characteristic.On)
			.on('get', this.getState.bind(this))
			.on('set', this.setState.bind(this));

		this.contactService.getCharacteristic(Characteristic.ContactSensorState)
			.updateValue(this.historyExtra.lastStatus)
			.on('change', this.getStatusActive.bind(this));

		if (!this.contactService.testCharacteristic(Characteristic.LastActivation))this.contactService.addCharacteristic(Characteristic.LastActivation);
		this.contactService.getCharacteristic(Characteristic.LastActivation)
			.updateValue(this.historyExtra.lastActivation);

		if (!this.contactService.testCharacteristic(Characteristic.TimesOpened))this.contactService.addCharacteristic(Characteristic.TimesOpened);
		this.contactService.getCharacteristic(Characteristic.TimesOpened)
			.updateValue(this.historyExtra.timesOpened);

		if (!this.contactService.testCharacteristic(Characteristic.OpenDuration))this.contactService.addCharacteristic(Characteristic.OpenDuration);
		this.contactService.getCharacteristic(Characteristic.OpenDuration)
			.updateValue(this.historyExtra.openDuration);

		if (!this.contactService.testCharacteristic(Characteristic.ClosedDuration))this.contactService.addCharacteristic(Characteristic.ClosedDuration);
		this.contactService.getCharacteristic(Characteristic.ClosedDuration)
			.updateValue(this.historyExtra.closedDuration);

		if (!this.contactService.testCharacteristic(Characteristic.ResetTotal))this.contactService.addCharacteristic(Characteristic.ResetTotal);
		this.contactService.getCharacteristic(Characteristic.ResetTotal)
			.updateValue(this.historyExtra.lastReset);
			
			
		this.loggingService = new FakeGatoHistoryService("door", this, {
			disableTimer: true,
			disableRepeatLastData: false,
			storage: 'fs',
			length : Math.pow(2, 14),
			path: _homebridge.user.storagePath()+'/fakegato/',
		});
		
		this.loadExtra()
		
		clearTimeout(this.timer);
		this.timer = setTimeout(function() {
			this.log('Start timer to activate Fakegato!');
			this.getState();
		}.bind(this), 10000);

		return [informationService, this.contactService, this.loggingService];
	}
};
