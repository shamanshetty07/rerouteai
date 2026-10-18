import type { Station } from "./types.ts";

// Real stations with their official Indian Railways codes. Replace with an API-backed
// StationSource (see stationSource.ts) when a real data source is wired in.
const rows: [code: string, name: string, city: string][] = [
  // Delhi
  ["NDLS", "New Delhi", "Delhi"],
  ["DLI", "Delhi Junction", "Delhi"],
  ["NZM", "Hazrat Nizamuddin", "Delhi"],
  ["ANVT", "Anand Vihar Terminal", "Delhi"],
  // Mumbai
  ["CSMT", "Chhatrapati Shivaji Maharaj Terminus", "Mumbai"],
  ["MMCT", "Mumbai Central", "Mumbai"],
  ["LTT", "Lokmanya Tilak Terminus", "Mumbai"],
  ["BDTS", "Bandra Terminus", "Mumbai"],
  ["DR", "Dadar", "Mumbai"],
  ["TNA", "Thane", "Thane"],
  ["PNVL", "Panvel", "Navi Mumbai"],
  ["KYN", "Kalyan Junction", "Kalyan"],
  // Bengaluru
  ["SBC", "KSR Bengaluru City Junction", "Bengaluru"],
  ["YPR", "Yesvantpur Junction", "Bengaluru"],
  ["BNC", "Bengaluru Cantonment", "Bengaluru"],
  ["KJM", "Krishnarajapuram", "Bengaluru"],
  ["SMVB", "Sir M. Visvesvaraya Terminal", "Bengaluru"],
  // Chennai
  ["MAS", "Chennai Central", "Chennai"],
  ["MS", "Chennai Egmore", "Chennai"],
  ["TBM", "Tambaram", "Chennai"],
  // Hyderabad
  ["SC", "Secunderabad Junction", "Hyderabad"],
  ["HYB", "Hyderabad Deccan", "Hyderabad"],
  ["KCG", "Kacheguda", "Hyderabad"],
  // Kolkata
  ["HWH", "Howrah Junction", "Kolkata"],
  ["SDAH", "Sealdah", "Kolkata"],
  // Other major stations and junctions
  ["PUNE", "Pune Junction", "Pune"],
  ["ADI", "Ahmedabad Junction", "Ahmedabad"],
  ["BRC", "Vadodara Junction", "Vadodara"],
  ["ST", "Surat", "Surat"],
  ["JP", "Jaipur Junction", "Jaipur"],
  ["JU", "Jodhpur Junction", "Jodhpur"],
  ["AGC", "Agra Cantt", "Agra"],
  ["GWL", "Gwalior Junction", "Gwalior"],
  ["LKO", "Lucknow Charbagh", "Lucknow"],
  ["CNB", "Kanpur Central", "Kanpur"],
  ["PRYJ", "Prayagraj Junction", "Prayagraj"],
  ["BSB", "Varanasi Junction", "Varanasi"],
  ["PNBE", "Patna Junction", "Patna"],
  ["GHY", "Guwahati", "Guwahati"],
  ["BBS", "Bhubaneswar", "Bhubaneswar"],
  ["BPL", "Bhopal Junction", "Bhopal"],
  ["NGP", "Nagpur Junction", "Nagpur"],
  ["ASR", "Amritsar Junction", "Amritsar"],
  ["CDG", "Chandigarh", "Chandigarh"],
  ["VSKP", "Visakhapatnam Junction", "Visakhapatnam"],
  ["BZA", "Vijayawada Junction", "Vijayawada"],
  ["MAO", "Madgaon Junction", "Margao"],
  ["UBL", "Hubballi Junction", "Hubballi"],
  ["MYS", "Mysuru Junction", "Mysuru"],
  ["ERS", "Ernakulam Junction", "Kochi"],
  ["TVC", "Thiruvananthapuram Central", "Thiruvananthapuram"],
  // Intermediate halts used by the mock trains
  ["RTM", "Ratlam Junction", "Ratlam"],
  ["KOTA", "Kota Junction", "Kota"],
  ["DHN", "Dhanbad Junction", "Dhanbad"],
  ["GAYA", "Gaya Junction", "Gaya"],
  ["DDU", "Pt. Deen Dayal Upadhyaya Junction", "Mughalsarai"],
  ["RKMP", "Rani Kamalapati", "Bhopal"],
  ["ET", "Itarsi Junction", "Itarsi"],
  ["LDH", "Ludhiana Junction", "Ludhiana"],
  ["SUR", "Solapur", "Solapur"],
  ["DD", "Daund Junction", "Daund"],
  ["BSL", "Bhusawal Junction", "Bhusawal"],
  ["BSP", "Bilaspur Junction", "Bilaspur"],
  ["CBE", "Coimbatore Junction", "Coimbatore"],
  ["MDU", "Madurai Junction", "Madurai"],
];

export const mockStations: readonly Station[] = rows.map(([code, name, city]) => ({
  id: code,
  code,
  name,
  city,
}));
