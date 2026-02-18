// ========================================
// FIREBASE CONFIGURATION
// ========================================

const firebaseConfig = {
  apiKey: "AIzaSyCzb-ZWetwx9Uy4WhJxBiwzJsZGgmrL_nc",
  authDomain: "clinica-dental-dra-smith.firebaseapp.com",
  projectId: "clinica-dental-dra-smith",
  storageBucket: "clinica-dental-dra-smith.firebasestorage.app",
  messagingSenderId: "845983933030",
  appId: "1:845983933030:web:cc0b5a3724be89c86c43a7"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

console.log('🔥 Firebase initialized');
