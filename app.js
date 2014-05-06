var express = require('express');
var dotenv = require('dotenv');
var events = require('events');
dotenv.load();

var app = express();
var PORT = Number(process.env.PORT || 9222);
var HOST = process.env.HOST || 'localhost';
var CUR_HOST = process.env.CUR_HOST || "localhost/";

var ALLEVENTS = [
	'processed', 'delivered', 'open',
	'click', 'bounce', 'dropped', 'spamreport',
	'unsubscribe'
];

var REDISHOST = process.env.REDISHOST;
var REDISPORT = process.env.REDISPORT;
var redis_namespace = "SGEVENT";
var redis = require('redis');
if (process.env.REDISTOGO_URL) {
    var rtg   = require("url").parse(process.env.REDISTOGO_URL);
	var client = redis.createClient(rtg.port, rtg.hostname);
	client.auth(rtg.auth.split(":")[1]);
} else {
	var client = redis.createClient(REDISPORT,REDISHOST);
}

var sg_user = process.env.SENDGRID_USERNAME;
var sg_key = process.env.SENDGRID_PASSWORD;
var sendgrid = require('sendgrid')(sg_user, sg_key);

// Config for app
app.use(express.bodyParser());
app.use(express.errorHandler());
app.use(express.logger());
app.set('view engine', 'jade');
app.locals({"notice": false});

// User functions
app.get('/users', function(req, res) {
	getUsers(res, 'user_index');
});

app.post('/users', function(req, res) {
	console.log(req.body);
	var user = {
		username: req.body['username'],
		email: req.body['email']
	};
	console.log("Adding user", user);
	client.scard(redis_namespace+'::users', function(err, size){
		var new_id = size + 1;
		var hash_key = redis_namespace+'::users::'+new_id;
		console.log("ID and Hash", new_id, hash_key);
		client.hmset(hash_key, user);
		client.sadd(redis_namespace+'::users', new_id);
		res.render('user_index', {notice: "Added user "+new_id});
	});
});

// Link for users to visit
app.get('/sale/:code', function(req, res) {
	res.send(req.params.code, 200);
});

app.get('/send', function(req, res) {
	getUsers(res, 'send');
});

app.post('/send', function(req, res) {
	var emails = req.body['emails'];
	var coupon_code = req.body['code'];
	if (typeof(emails)=="string") {
		emails = [emails];
	}
	console.log("Sending coupon", coupon_code, "to", emails);
	var uuid = getUUID(); // make uuid
	var send_key = redis_namespace + "::send::" + uuid;
	var all_sends = redis_namespace + "::sends";
	client.sadd(all_sends, uuid);
	for (var i=0; i< emails.length; i++) {
		(function(id) {
			// Send email
			var email = emails[id];
			var email_send = new sendgrid.Email({
				to: email, subject: "Check out sale with code " + coupon_code,
				from: "david.tomberlin@sendgrid.com",
				html: getHtml(coupon_code),
			});
			email_send.addUniqueArg({"uuid":uuid});
			email_send.addUniqueArg({"coupon_code":coupon_code});
			sendgrid.send(email_send, function(err, json){
				if (err){
					console.error(err);
					res.send("Error", 400);
				} else {
					var data = {
						email: email,
						my_sent: true,
						my_purchase: false,
						coupon_code: coupon_code,
					};
					console.log("Savng data", data);
					for (var j = ALLEVENTS.length - 1; j >= 0; j--) {
						data[ALLEVENTS[j]] = false;
					};
					// Log data in redis
					var hash_key = redis_namespace+"::"+email+"::"+uuid;
					client.hmset(hash_key, data);
					client.sadd(send_key, email, function(err, mem) {
						console.log("now it's safe");
						if (id == emails.length-1) {
							res.redirect("/stats/"+uuid);
						}
					});
				}
			})
		})(i);
	}
});

app.get("/stats/:uuid", function(req, res) {
	console.log(req.params.uuid);
	var uuid = req.params.uuid;
	var send_key = redis_namespace + "::send::" + uuid;
	var users = new events.EventEmitter();
	users.users = [];
	users.on('add', function(user) {
		console.log('adding');
		users.users.push(user);
	});
	users.on('fin', function(res, template){
		console.log('fin!');
		res.render(template, {users:users.users, uuid: uuid});
	});
	users.on('error', function(res, err){
		console.error(err);
		res.send("Redis Error", 400);
	});
	console.log("Showing stats for", uuid);
	client.smembers(send_key, function(err, user_sends) {
		console.log('user_sends', user_sends);
		if (err) {
			console.error(err);
			res.send(err, 400);
		}
		// res.send(user_sends, 200);
		for (var i = 0; i<user_sends.length; i++) {
			(function(index){
				var email = user_sends[index];
				var hash_key = redis_namespace+"::"+email+"::"+uuid;
				client.hgetall(hash_key, function(err, obj) {
					users.emit('add', obj);
					if (index == user_sends.length-1){
						users.emit('fin', res, 'stats');
					}
				});
			})(i);
		};
	});
});

app.get("/stats", function(req, res) {
	var all_sends = redis_namespace + "::sends";
	client.smembers(all_sends, function(err, user_sends) {
		if (err) {
			console.error(err);
			res.send("Error", 400);
		}
		res.render('stats', {sends: user_sends});
	});
});

// Event Hook
// [{"email":"siyegen@gmail.com","smtp-id":"<145cff1ee1e.5889.25296d@localhost.localdomain>","timestamp":1399353112,"response":"250 2.0.0 OK 1399353112 gl4si17142074igd.17 - gsmtp ","sg_event_id":"KpCFqW-aQRCzt5q5DDcE6Q","uuid":2,"event":"delivered"}]
app.post('/sg_event', function(req, res) {
	console.log(req.body);
	var sg_data = req.body[0];
	var sg_event = sg_data['event'];
	var uuid = sg_data['uuid'];
	var hash_key = redis_namespace+"::"+sg_data['email']+"::"+uuid;
	var data = {
		uuid: uuid,
		email: sg_data['email'],
		coupon_code: sg_data['coupon_code'],
	};
	data[sg_event] = true;
	console.log("Setting data for", hash_key);
	console.log(data);
	client.hmset(hash_key, data);
	res.send("okay", 200);
});

app.listen(PORT);
console.log("Starting on", HOST, PORT);

function getHtml(coupon_code) {
	var link = CUR_HOST+"sale/"+coupon_code;
	return 'Check out this great sale!<br>'+
			'<a href="'+link+'">Here!</a>';
}

function getUsers(res, template) {
	var users = new events.EventEmitter();
	users.users = [];
	users.on('add', function(user) {
		console.log('adding');
		users.users.push(user);
	});
	users.on('fin', function(res, template){
		console.log('fin!');
		res.render(template, {users:users.users});
	});
	users.on('error', function(res, err){
		console.error(err);
		res.send("Redis Error", 400);
	});

	client.smembers(redis_namespace+'::users', function(err, replies) {
		if (err) {
			users.emit('error', res, err);
		} else {
			console.log(replies);
			console.log(replies.length);
			if (replies.length == 0) {
				users.emit('fin', res, template);
			}
			for (var i=0; i<replies.length; i++) {
				(function(index) {
					var hash_key = redis_namespace+'::users::'+replies[index];
					console.log('getting', hash_key)
					client.hgetall(hash_key, function(err, obj) {
						console.log(err, obj);
						console.log("i, len", index, replies.length);
						users.emit('add', obj);
						if (index == replies.length-1){
							users.emit('fin', res, template);
						}
					});
				})(i);
			}
		}
	});
}

function getUUID() {
	return 'xxxxxxxx'.replace(/[xy]/g, function(c) {
	    var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
	    return v.toString(16);
	});
}