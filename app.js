var express = require('express');
var dotenv = require('dotenv');
var events = require('events');
dotenv.load();

var app = express();
var PORT = Number(process.env.PORT || 9222);
var HOST = process.env.HOST || 'localhost';

var REDISHOST = process.env.REDISHOST;
var REDISPORT = process.env.REDISPORT;
var redis = require('redis');
var client = redis.createClient(REDISPORT,REDISHOST);
var redis_namespace = "SGEVENT";

// Config for app
app.use(express.bodyParser());
app.use(express.errorHandler());
app.use(express.logger());
app.set('view engine', 'jade');
app.locals({"notice": false});

// User functions
app.get('/users', function(req, res) {
	var users = new events.EventEmitter();
	users.users = [];
	users.on('add', function(user) {
		console.log('adding');
		users.users.push(user);
	});
	users.on('fin', function(res){
		console.log('fin!');
		res.render('user_index', {users:users.users});
	});
	client.smembers(redis_namespace+'::users', function(err, replies) {
		if (err) {
			console.log(err);
			res.send("Redis Error", 400);
		} else {
			console.log(replies);
			console.log(replies.length);
			for (var i=0; i<replies.length; i++) {
				(function(index) {
					var hash_key = redis_namespace+'::users::'+replies[index];
					console.log('getting', hash_key)
					client.hgetall(hash_key, function(err, obj) {
						console.log(err, obj);
						console.log("i, len", index, replies.length);
						users.emit('add', obj);
						if (index == replies.length-1){
							users.emit('fin', res);
						}
					});
				})(i);
			}
		}
	});
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

app.delete('/users', function(req, res) {
	res.render('user_index');
});

// Link for users to visit
app.get('/sale/:code', function(req, res) {
	res.send(req.params.code, 200);
});

// Event Hook
app.post('/sg_event_', function(req, res) {

});

app.listen(PORT);
console.log("Starting on", HOST, PORT);
