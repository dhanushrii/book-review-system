const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const neo4j = require('neo4j-driver');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const driver = neo4j.driver('bolt://localhost', neo4j.auth.basic('neo4j', 'dhanushrii'));
const sessionDb = driver.session(); 

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.render('register', { error: 'All fields are required!' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const sessionDb = driver.session();
    try {
        const checkUser = await sessionDb.run(
            'MATCH (u:User {email: $email}) RETURN u',
            { email }
        );
        if (checkUser.records.length > 0) {
            return res.render('register', { error: 'Email is already registered!' });
        }
        await sessionDb.run(
            'CREATE (u:User {username: $username, email: $email, password: $password}) RETURN u',
            { username, email, password: hashedPassword }
        );

        res.redirect('/login');
    } catch (error) {
        console.error('Error registering user:', error);
        res.render('register', { error: 'Registration failed. Please try again.' });
    } finally {
        await sessionDb.close();
    }
});

app.use(session({
    secret: 'your-secret-key', 
    resave: false,
    saveUninitialized: false, 
    cookie: {
        httpOnly: true, 
        secure: false,
    }
}));

app.get('/', (req, res) => {
    if (req.session.user) {
        return res.redirect('/home');  
    }
    res.redirect('/login'); 
});

app.get('/login', (req, res) => {
    res.render('login', { error: null }); 
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const sessionDriver = driver.session();
    try {
        const result = await sessionDriver.run(
            'MATCH (u:User {username: $username}) RETURN u',
            { username }
        );
        if (result.records.length === 0) {
            return res.status(400).send('Invalid credentials');
        }
        const user = result.records[0].get('u').properties;
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(400).send('Invalid credentials');
        }
        req.session.user = {
            email: user.email,  
            username: user.username
        };
        res.redirect('/home');
    } catch (error) {
        console.error('❌ Login Error:', error);
        res.status(500).send('Login failed');
    } finally {
        await sessionDriver.close();
    }
});

app.get("/home", async (req, res) => {
    const { search, sort } = req.query;
    let query = `MATCH (b:Book) 
                 OPTIONAL MATCH (b)<-[r:RATED]-() 
                 RETURN b.title AS title, b.author AS author, 
                        COALESCE(AVG(toFloat(r.rating)), 0) AS avgRating`;

    if (search) {
        query = `MATCH (b:Book) 
                 WHERE toLower(b.title) CONTAINS toLower($search) 
                 OPTIONAL MATCH (b)<-[r:RATED]-() 
                 RETURN b.title AS title, b.author AS author, 
                        COALESCE(AVG(toFloat(r.rating)), 0) AS avgRating`;
    }

    if (sort === "asc") {
        query += " ORDER BY avgRating ASC";
    } else if (sort === "desc") {
        query += " ORDER BY avgRating DESC";
    }

    const sessionDb = driver.session();
    try {
        const result = await sessionDb.run(query, { search });
        const books = result.records.map(record => ({
            title: record.get('title'),
            author: record.get('author'),
            avgRating: record.get('avgRating') ? parseFloat(record.get('avgRating')) : 0  
        }));
        res.render("home", { books, search, sort });
    } catch (error) {
        console.error("Error fetching books:", error);
        res.status(500).send("Internal Server Error");
    } finally {
        await sessionDb.close();
    }
});

app.get('/mybooks', async (req, res) => {
    if (!req.session.user) return res.redirect('/login'); 
    const sessionDriver = driver.session();
    try {
        const result = await sessionDriver.run(
            `MATCH (u:User {email: $email})-[:OWNS]->(b:Book) 
             OPTIONAL MATCH (b)<-[r:RATED]-() 
             RETURN b.title AS title, COALESCE(AVG(toFloat(r.rating)), 0) AS avgRating`,
            { email: req.session.user.email }
        );

        const books = result.records.map(record => ({
            title: record.get('title'),
            rating: record.get('avgRating') ? parseFloat(record.get('avgRating')) : 0
        }));
        res.render('mybooks', { books });
    } catch (error) {
        console.error('Error Fetching User Books:', error);
        res.status(500).send('Error loading books');
    } finally {
        await sessionDriver.close();
    }
});

app.get('/publish', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');  
    }
    res.render('publish', { successMessage: null, error: null });  
});

app.post('/mybooks/add', async (req, res) => {
    const { title, author, contents } = req.body;
    const email = req.session.user.email;

    const sessionDb = driver.session();
    try {
        const result = await sessionDb.run(
            `CREATE (b:Book {title: $title, author: $author, contents: $contents}) RETURN b`,
            { title, author, contents }
        );

        const book = result.records[0].get('b');
        
        await sessionDb.run(
            `MATCH (u:User {email: $email}), (b:Book {title: $title}) 
             CREATE (u)-[:OWNS]->(b)`,
            { email, title }
        );

        res.render('publish', { successMessage: 'Book published successfully!', error: null });
    } catch (err) {
        console.error("Error publishing book:", err);
        res.render('publish', { successMessage: null, error: 'Error occurred while publishing book.' });
    } finally {
        await sessionDb.close();
    }
});

app.post('/rate/:bookTitle', async (req, res) => {
    const bookTitle = req.params.bookTitle;
    const userRating = req.body.rating;  
    const sessionDriver = driver.session();

    try {
        const result = await sessionDriver.run(
            'MATCH (b:Book {title: $bookTitle}), (u:User {email: $email}) ' +
            'MERGE (u)-[r:RATED]->(b) ' +
            'SET r.rating = $rating ' +
            'RETURN b',
            { bookTitle, email: req.session.user.email, rating: userRating } 
        );

        res.redirect('/home');
    } catch (error) {
        console.error('Error updating rating:', error);
        res.status(500).send('Error updating rating');
    } finally {
        await sessionDriver.close();
    }
});

app.get('/profile', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    const email = req.session.user.email;  
    sessionDb.run('MATCH (u:User {email: $email}) RETURN u', { email })
        .then(result => {
            const user = result.records[0].get('u').properties;
            res.render('profile', { user });
        })
        .catch(err => {
            console.log(err);
            res.status(500).send('Error loading profile');
        });
});

app.get('/profile/update', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    const email = req.session.user.email;
    sessionDb.run('MATCH (u:User {email: $email}) RETURN u', { email })
        .then(result => {
            const user = result.records[0].get('u').properties;
            res.render('profile-update', { 
                user, error: null 
            });
        })
        .catch(err => {
            console.log(err);
            res.status(500).send('Error loading profile update form');
        });
});

app.post('/profile/update', async (req, res) => {
    const { username, email, bio } = req.body;

    if (!username || !email) {
        console.log("Error: Missing username or email");
        return res.render('profile-update', { 
            user: req.session.user, 
            error: 'Username and email are required.'
        });
    }
    try {
        const sessionDriver = driver.session();
        await sessionDriver.run(
            'MATCH (u:User {email: $email}) SET u.username = $username, u.email = $email, u.bio = $bio RETURN u',
            { email: req.session.user.email, username, email, bio }
        );
        req.session.user.username = username;
        req.session.user.email = email;
        req.session.user.bio = bio;
        res.redirect('/profile');
    } catch (error) {
        console.error('Error updating profile:', error);
        res.render('profile-update', { 
            user: req.session.user, 
            error: 'An error occurred while updating your profile.' // Pass error message
        });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).send('Failed to log out');
        }
        res.redirect('/login');
    });
});

app.get('/book-details/:bookTitle', async (req, res) => {
    const bookTitle = req.params.bookTitle;
    try {
        const sessionDriver = driver.session();
        const result = await sessionDriver.run(
            `MATCH (b:Book {title: $bookTitle}) 
             OPTIONAL MATCH (b)<-[r:RATED]-(u:User) 
             RETURN b.title AS title, b.author AS author, b.contents AS contents, 
                    COALESCE(AVG(toFloat(r.rating)), 0) AS avgRating, collect(r.rating) AS ratings`,
            { bookTitle }
        );

        if (result.records.length === 0) {
            return res.status(404).send("Book not found");
        }

        const bookRecord = result.records[0];
        const ratings = bookRecord.get('ratings') || [];
        const avgRating = bookRecord.get('avgRating') || 0;
        const book = {
            title: bookRecord.get('title'),
            author: bookRecord.get('author'),
            contents: bookRecord.get('contents'),
            avgRating,
            ratings
        };
        res.render('book-details', { book });
    } catch (error) {
        console.error('Error fetching book details:', error);
        res.status(500).send('Error fetching book details');
    }
});

app.post("/remove-rating/:title", async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).send("Unauthorized: User not logged in");
    }
    const bookTitle = decodeURIComponent(req.params.title);
    const userEmail = req.session.user.email; 
    try {
        const sessionDriver = driver.session();
        const result = await sessionDriver.run(
            `MATCH (u:User {email: $email})-[r:RATED]->(b:Book {title: $title}) 
             DELETE r`,
            { email: userEmail, title: bookTitle }
        );
        await sessionDriver.close();
        console.log(`Rating removed for book: ${bookTitle} by user: ${userEmail}`);
        res.redirect(`/book-details/${encodeURIComponent(bookTitle)}`);
    } catch (error) {
        console.error("Error removing rating:", error);
        res.status(500).send("Failed to remove rating");
    }
});

app.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});